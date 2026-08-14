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
  });
}

function completeTask(taskId: number, result: string): void {
  write((db) => {
    db.query(
      `UPDATE tasks SET status = 'completed', progress = 100, result = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    ).run(result, taskId);
  });
}

function failTask(taskId: number, error: string): void {
  write((db) => {
    db.query(
      `UPDATE tasks SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(error, taskId);
  });
}

async function executeTask(task: TaskRow): Promise<string> {
  // Simulate task execution with progress updates
  const steps = ["navigate", "login", "collect", "screenshot"];

  for (let i = 0; i < steps.length; i++) {
    process.send?.({ type: "progress", taskId: task.id, progress: Math.round((i / steps.length) * 100) });
    updateProgress(task.id, Math.round((i / steps.length) * 100));

    // Simulate work
    await new Promise((r) => setTimeout(r, 500));
  }

  return JSON.stringify({ url: task.url, steps, timestamp: new Date().toISOString() });
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
    write((db) => {
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
