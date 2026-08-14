/**
 * Task worker — runs in a spawned Bun process.
 *
 * Receives task IDs via IPC (process.on("message")),
 * loads the task from the database, executes the automation steps,
 * and reports progress/results back via process.send().
 *
 * In production, this would use Bun.WebView for browser automation.
 * For now, it's a stub that simulates task execution.
 */

import { write, read } from "../db";
import { withRetry } from "../utils/retry";
import { recordSuccess, recordFailure } from "../utils/circuit-breaker";
import { processScreenshot, type ScreenshotResult } from "../utils/image";

interface TaskRow {
  id: number;
  agent_id: number;
  url: string;
  proxy: string | null;
  user_agent: string | null;
  geo_lat: number | null;
  geo_lon: number | null;
}

function loadTask(taskId: number): TaskRow | null {
  return read((db) => {
    return db.query("SELECT id, agent_id, url, proxy, user_agent, geo_lat, geo_lon FROM tasks WHERE id = ?").get(taskId) as TaskRow | null;
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

async function executeTask(task: TaskRow): Promise<string> {
  const steps = ["navigate", "login", "collect", "screenshot"];

  // Generate a synthetic screenshot via Bun.Image.
  // In production, Bun.WebView would capture a real page screenshot.
  // Here we create a 1280x720 placeholder and process it through the
  // full pipeline (resize → WebP → thumbnail → thumbhash → metadata).
  const screenshotBuf = generatePlaceholderScreenshot(task);

  let screenshotResult: ScreenshotResult | null = null;
  for (let i = 0; i < steps.length; i++) {
    const progress = Math.round((i / steps.length) * 100);
    process.send?.({ type: "progress", taskId: task.id, progress });
    updateProgress(task.id, progress);

    if (steps[i] === "screenshot") {
      screenshotResult = await processScreenshot(screenshotBuf, `task-${task.id}`);
    }

    // Simulate work
    await new Promise((r) => setTimeout(r, 500));
  }

  // Store the screenshot session in the database
  if (screenshotResult) {
    const sessionId = await write((db) => {
      const r = db.query(
        `INSERT INTO sessions (task_id, screenshot_path, screenshot_color, expires_at)
         VALUES (?, ?, ?, datetime('now', '+24 hours'))`,
      ).run(
        task.id,
        screenshotResult.thumbPath,
        screenshotResult.dominantColor,
      );
      return Number(r.lastInsertRowid);
    });

    return JSON.stringify({
      url: task.url,
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
      timestamp: new Date().toISOString(),
    });
  }

  return JSON.stringify({ url: task.url, steps, timestamp: new Date().toISOString() });
}

/**
 * Generate a placeholder screenshot as a PNG ArrayBuffer.
 * Creates a 1280x720 image with the task URL rendered as colored bars.
 * In production, this would be replaced by Bun.WebView's screenshot API.
 */
function generatePlaceholderScreenshot(task: TaskRow): ArrayBuffer {
  // Create a simple 1280x720 PNG with a solid color background.
  // We build it manually to avoid any image library dependency —
  // Bun.Image handles the rest (resize, convert, thumbnail).
  const width = 1280;
  const height = 720;

  // Generate raw RGBA pixel data — a gradient based on the URL hash
  const hash = hashString(task.url);
  const r = (hash & 0xff0000) >> 16;
  const g = (hash & 0x00ff00) >> 8;
  const b = hash & 0x0000ff;

  // Raw image data: per row, 1 filter byte + width * 4 RGBA bytes
  const rowSize = 1 + width * 4;
  const raw = new Uint8Array(rowSize * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowSize] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const offset = y * rowSize + 1 + x * 4;
      // Gradient: interpolate between the hash color and a darker shade
      const factor = (x + y) / (width + height);
      raw[offset] = Math.round(r * (1 - factor * 0.5));
      raw[offset + 1] = Math.round(g * (1 - factor * 0.5));
      raw[offset + 2] = Math.round(b * (1 - factor * 0.5));
      raw[offset + 3] = 255;
    }
  }

  return encodePng(raw, width, height);
}

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Minimal PNG encoder (RGBA, 8-bit, no compression library needed — uses Bun's zlib). */
function encodePng(raw: Uint8Array, width: number, height: number): ArrayBuffer {
  // Use Bun's built-in zlib via node:zlib
  const { deflateSync } = require("node:zlib");

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;   // bit depth
  ihdrData[9] = 6;   // color type: RGBA
  ihdrData[10] = 0;  // compression
  ihdrData[11] = 0;  // filter
  ihdrData[12] = 0;  // interlace

  // IDAT chunk — deflate the raw data
  const idatData = deflateSync(Buffer.from(raw));

  const chunks = [signature, makeChunk("IHDR", ihdrData), makeChunk("IDAT", idatData), makeChunk("IEND", Buffer.alloc(0))];

  return Buffer.concat(chunks);
}

function makeChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeBuf, data), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function crc32(...bufs: Buffer[]): number {
  const { crc32 } = require("node:zlib");
  return crc32(Buffer.concat(bufs)) >>> 0;
}

// --- IPC handler -----------------------------------------------------------

// Keep the process alive waiting for IPC messages.
let keepAlive = setInterval(() => {}, 60_000);

process.on("message", async (msg: any) => {
  if (msg.type === "shutdown") {
    console.log(`[worker:${process.pid}] received shutdown signal`);
    clearInterval(keepAlive);
    process.exit(0);
  }

  if (msg.type === "task") {
    const taskId = msg.taskId as number;
    const task = loadTask(taskId);

    if (!task) {
      process.send?.({ type: "error", taskId, error: "task not found" });
      return;
    }

    // Mark task as running
    await write((db) => {
      db.query("UPDATE tasks SET status = 'running', started_at = datetime('now') WHERE id = ?").run(taskId);
    });

    try {
      const result = await withRetry(() => executeTask(task), {
        maxAttempts: 3,
        baseDelayMs: 2000,
        retryable: (e) => {
          const errMsg = e instanceof Error ? e.message : String(e);
          return !errMsg.includes("not found") && !errMsg.includes("auth");
        },
        onRetry: (attempt, delay) => {
          console.log(`[worker:${process.pid}] retry ${attempt} after ${delay}ms`);
          process.send?.({ type: "progress", taskId, progress: -1, retrying: attempt });
        },
      });

      completeTask(taskId, result);
      recordSuccess(new URL(task.url).host);
      process.send?.({ type: "result", taskId, result });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      failTask(taskId, errMsg);
      recordFailure(new URL(task.url).host);
      process.send?.({ type: "error", taskId, error: errMsg });
    }
  }
});

// Notify parent that we're ready
process.send?.({ type: "ready", pid: process.pid });
console.log(`[worker:${process.pid}] ready`);
