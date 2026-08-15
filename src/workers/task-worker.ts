/**
 * Task worker — runs in a spawned Bun process.
 *
 * Receives task IDs via IPC (process.on("message")),
 * loads the task from the database, executes browser automation
 * via Bun.WebView, and reports progress/results back via process.send().
 *
 * Uses Bun.WebView for real browser automation:
 * - navigate to the task URL
 * - capture a screenshot
 * - extract cookies/localStorage for session persistence (D2)
 * - per-agent dataStore directory for persistent profiles (D2)
 */

import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import * as os from "node:os";
import { write, read } from "../db";
import { withRetry } from "../utils/retry";
import { recordSuccess, recordFailure } from "../utils/circuit-breaker";
import { processScreenshot, type ScreenshotResult } from "../utils/image";
import type { ParentToWorkerMessage, WorkerToParentMessage } from "../types/ipc";
import type { TaskRow } from "../types/models";

// --- Config ----------------------------------------------------------------

const PROFILE_DIR = resolve(process.env.PROFILE_DIR ?? "./data/profiles");
const VIEWPORT_WIDTH = parseInt(process.env.VIEWPORT_WIDTH ?? "1280", 10);
const VIEWPORT_HEIGHT = parseInt(process.env.VIEWPORT_HEIGHT ?? "720", 10);
const NAV_TIMEOUT = parseInt(process.env.NAV_TIMEOUT ?? "30000", 10);

/** Race a promise against a timeout, rejecting with a clear error. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  // D2: Clear the timer when the promise settles first to prevent a leaked
  // timer and an unhandled rejection from the timeout promise.
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    }),
  ]);
}

/**
 * Detect macOS < 15.2 where WebKit persistent storage is unsupported.
 *
 * Uses node:os.release() which returns the Darwin kernel version.
 * macOS 15.2 maps to Darwin 24.2. We check Darwin >= 24.2.
 *
 * Ref: node_modules/bun-types/docs/runtime/webview.mdx#persistent-storage
 */
function supportsPersistentStorage(): boolean {
  if (process.platform !== "darwin") return true; // Linux uses Chrome backend
  const release = os.release();
  const parts = release.split(".");
  const major = parseInt(parts[0] ?? "0", 10);
  const minor = parseInt(parts[1] ?? "0", 10);
  // macOS 15.2 = Darwin 24.2
  return major > 24 || (major === 24 && minor >= 2);
}

// --- Task loading ----------------------------------------------------------

function loadTask(taskId: number): TaskRow | null {
  // G7: The worker is an internal subprocess — it only receives task IDs from
  // the server's submitTask(), which is called after the server has validated
  // agent_id ownership (E3 IDOR fix). No agent_id check here is needed.
  return read((db) => {
    return db
      .query(
        `SELECT id, agent_id, url, status, progress, priority, proxy, user_agent,
                geo_lat, geo_lon, error, result, created_at, updated_at, started_at, completed_at
         FROM tasks WHERE id = ?`,
      )
      // JUSTIFIED: bun:sqlite .get() returns unknown; narrowing to TaskRow | null
      .get(taskId) as TaskRow | null;
  });
}

function updateProgress(taskId: number, progress: number): void {
  write((db) => {
    db.query("UPDATE tasks SET progress = ?, updated_at = datetime('now') WHERE id = ?").run(progress, taskId);
  }).catch((e) => console.error(`[worker] updateProgress failed:`, e));
}

function completeTask(taskId: number, result: string): void {
  write((db) => {
    db.query(
      `UPDATE tasks SET status = 'completed', progress = 100, result = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    ).run(result, taskId);
  }).catch((e) => console.error(`[worker] completeTask failed:`, e));
}

function failTask(taskId: number, error: string): void {
  write((db) => {
    db.query(
      `UPDATE tasks SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(error, taskId);
  }).catch((e) => console.error(`[worker] failTask failed:`, e));
}

/** D9: Extract a meaningful site key from a URL for the circuit breaker. */
function getSiteKey(url: string): string {
  try {
    const parsed = new URL(url);
    // data: and file: URLs have empty host — use the protocol as the key
    return parsed.host || parsed.protocol || "unknown";
  } catch {
    return "unknown";
  }
}

// --- Browser automation ----------------------------------------------------

/**
 * Execute a task using Bun.WebView for real browser automation.
 *
 * Steps:
 * 1. Navigate to the task URL
 * 2. Wait for page load
 * 3. Capture a screenshot
 * 4. Extract cookies + localStorage for session persistence (D2)
 * 5. Process the screenshot through the image pipeline
 * 6. Store the session in the database
 *
 * Uses `await using view` for automatic cleanup (I4 — native Symbol.asyncDispose).
 * Uses per-agent dataStore directory for persistent cookies/storage (D2).
 */
async function executeTask(task: TaskRow): Promise<string> {
  const steps = ["navigate", "screenshot", "extract-session"];

  // Per-agent profile directory for persistent cookies/localStorage (D2)
  const agentProfileDir = resolve(PROFILE_DIR, `agent-${task.agent_id}`);

  // Build WebView options
  // m8: On macOS < 15.2, WebKit persistent storage is unsupported — fall back to ephemeral.
  const usePersistent = supportsPersistentStorage();
  if (usePersistent) {
    mkdirSync(agentProfileDir, { recursive: true }); // D8: only call once
  }
  const viewOptions: ConstructorParameters<typeof Bun.WebView>[0] = {
    width: VIEWPORT_WIDTH,
    height: VIEWPORT_HEIGHT,
    // m8: Fall back to ephemeral on old macOS — sessions won't persist but task still runs
    dataStore: usePersistent ? { directory: agentProfileDir } : "ephemeral",
    // m2: Capture page-side console output for debugging automation failures
    console: (type, ...args) => {
      if (type === "error" || type === "warn") {
        console.error(`[webview:${task.id}] page ${type}:`, ...args);
      }
    },
  };

  let screenshotResult: ScreenshotResult | null = null;
  let cookies = "";
  let localStorageData: Record<string, string> = {};
  let pageTitle = "";
  let finalUrl = task.url;

  // await using — automatic view.close() on scope exit (including errors)
  await using view = new Bun.WebView(viewOptions);

  // m3: Set navigation callbacks for observability (fires before navigate() settles)
  view.onNavigated = (url, title) => {
    console.log(`[webview:${task.id}] navigated to ${url} (${title})`);
  };
  view.onNavigationFailed = (error) => {
    console.error(`[webview:${task.id}] navigation failed:`, error.message);
  };

  // Step 1: Navigate to the task URL (C2: with timeout to prevent hanging forever)
  process.send?.({ type: "progress", taskId: task.id, progress: 0 });
  updateProgress(task.id, 0);

  await withTimeout(view.navigate(task.url), NAV_TIMEOUT, "navigate");
  pageTitle = view.title ?? "";
  finalUrl = view.url ?? task.url;

  // m1: Override user agent via CDP if provided (Chrome backend only)
  if (task.user_agent) {
    try {
      await view.cdp("Emulation.setUserAgentOverride", { userAgent: task.user_agent });
    } catch {
      // WebKit backend doesn't support CDP — user agent override silently skipped
    }
  }

  process.send?.({ type: "progress", taskId: task.id, progress: 25 });
  updateProgress(task.id, 25);

  // Step 2: Capture screenshot (m7: use blob encoding — zero-copy on WebKit)
  const screenshotBlob = await view.screenshot({ format: "png" });
  screenshotResult = await processScreenshot(screenshotBlob, `task-${task.id}`);

  process.send?.({ type: "progress", taskId: task.id, progress: 50 });
  updateProgress(task.id, 50);

  // Step 3: Extract session data for persistence (D2)
  try {
    cookies = await view.evaluate("document.cookie") ?? "";
  } catch {
    // Some pages block cookie access — non-fatal
    cookies = "";
  }

  try {
    const lsJson = await view.evaluate(
      "(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return JSON.stringify(o); })()",
    );
    // JUSTIFIED: evaluate() returns unknown; JSON.parse returns any — narrowing to Record
    localStorageData = lsJson ? JSON.parse(lsJson as string) as Record<string, string> : {};
  } catch {
    // localStorage may be inaccessible on some pages — non-fatal
    localStorageData = {};
  }

  process.send?.({ type: "progress", taskId: task.id, progress: 75 });
  updateProgress(task.id, 75);

  // Step 4: Store the screenshot session in the database (with cookies/localStorage — D2)
  let sessionId: number | null = null;
  if (screenshotResult) {
    sessionId = await write((db) => {
      const r = db.query(
        `INSERT INTO sessions (task_id, screenshot_path, screenshot_color, cookies, local_storage, session_storage, expires_at)
         VALUES (?, ?, ?, ?, ?, '{}', datetime('now', '+24 hours'))`,
      ).run(
        task.id,
        screenshotResult.thumbPath,
        screenshotResult.dominantColor,
        cookies,
        JSON.stringify(localStorageData),
      );
      return Number(r.lastInsertRowid);
    });

    process.send?.({ type: "progress", taskId: task.id, progress: 100 });
    updateProgress(task.id, 100);

    return JSON.stringify({
      url: task.url,
      final_url: finalUrl,
      title: pageTitle,
      steps,
      session_id: sessionId,
      screenshot: {
        full: screenshotResult.fullPath,
        thumb: screenshotResult.thumbPath,
        width: screenshotResult.metadata.width,
        height: screenshotResult.metadata.height,
        full_size: screenshotResult.fullSize,
        thumb_size: screenshotResult.thumbSize,
      },
      session_data: {
        cookies: cookies.length > 0,
        local_storage_keys: Object.keys(localStorageData).length,
      },
      timestamp: new Date().toISOString(),
    });
  }

  return JSON.stringify({ url: task.url, title: pageTitle, steps, timestamp: new Date().toISOString() });
}

// --- IPC handler -----------------------------------------------------------

/** D7: Send a message to the parent, detecting if the IPC channel is closed. */
function sendToParent(msg: WorkerToParentMessage): boolean {
  if (typeof process.send !== "function") {
    console.error(`[worker:${process.pid}] IPC channel closed — cannot send ${msg.type}`);
    return false;
  }
  try {
    process.send(msg);
    return true;
  } catch {
    console.error(`[worker:${process.pid}] IPC send failed — channel may be closed`);
    return false;
  }
}

// Keep the process alive waiting for IPC messages.
const keepAlive = setInterval(() => {}, 60_000);

process.on("message", async (msg: ParentToWorkerMessage) => {
  if (msg.type === "shutdown") {
    console.log(`[worker:${process.pid}] received shutdown signal`);
    clearInterval(keepAlive);
    // C3: Don't call Bun.WebView.closeAll() — `await using view` handles per-view
    // cleanup, and Bun automatically calls closeAll() at process exit.
    // Manual closeAll() does SIGKILL which could race with await using's close().
    process.exit(0);
  }

  if (msg.type === "task") {
    const taskId = msg.taskId;

    // D10: Wrap the entire task processing in a try/catch to prevent unhandled
    // errors from leaving the keepAlive interval running forever.
    try {
      const task = loadTask(taskId);

      if (!task) {
        sendToParent({ type: "error", taskId, error: "task not found" });
        return;
      }

      // D4: Guard against duplicate processing — if the task is already running
      // (e.g. due to a dispatch race), skip it instead of processing twice.
      if (task.status === "running") {
        console.warn(`[worker:${process.pid}] task ${taskId} is already running — skipping duplicate`);
        sendToParent({ type: "error", taskId, error: "task already running" });
        return;
      }

      // Mark task as running
      await write((db) => {
        db.query("UPDATE tasks SET status = 'running', started_at = datetime('now') WHERE id = ?").run(taskId);
      });

      const result = await withRetry(() => executeTask(task), {
        maxAttempts: 3,
        baseDelayMs: 2000,
        retryable: (e) => {
          const errMsg = e instanceof Error ? e.message : String(e);
          // Don't retry on "not found", "auth", or navigation errors that won't resolve
          return !errMsg.includes("not found") && !errMsg.includes("auth");
        },
        onRetry: (attempt, delay) => {
          console.log(`[worker:${process.pid}] retry ${attempt} after ${delay}ms`);
          sendToParent({ type: "progress", taskId, progress: -1, retrying: attempt });
        },
      });

      completeTask(taskId, result);
      // E6: Catch circuit breaker write rejections — don't let them become
      // unhandled rejections that could crash the worker.
      recordSuccess(getSiteKey(task.url)).catch((e) =>
        console.error(`[worker:${process.pid}] recordSuccess failed:`, e),
      );
      // D7: If IPC is closed, the task is still completed in the DB — just can't notify
      sendToParent({ type: "result", taskId, result });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      failTask(taskId, errMsg);
      // D9: Use getSiteKey to handle data:/file: URLs gracefully
      // E6: Catch circuit breaker write rejections
      try {
        const task = loadTask(taskId);
        if (task) {
          recordFailure(getSiteKey(task.url)).catch((e) =>
            console.error(`[worker:${process.pid}] recordFailure failed:`, e),
          );
        }
      } catch {} // best-effort — don't mask the original error
      sendToParent({ type: "error", taskId, error: errMsg });
    }
  }
});

// Notify parent that we're ready
sendToParent({ type: "ready", pid: process.pid });
console.log(`[worker:${process.pid}] ready`);
