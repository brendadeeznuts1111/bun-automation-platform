/**
 * Shared structured log function + in-memory ring buffer.
 *
 * This is NOT a full logger module — it's the inline `log()` function that
 * used to live in server.ts, extracted to a shared file so pool.ts can import
 * it without creating a circular dependency (server.ts imports from pool.ts).
 *
 * Workers run in separate Bun.spawn processes and can't share this buffer.
 * They send log entries via IPC ({ type: "log", ... }) and pool.ts relays
 * them here. See src/types/ipc.ts and the "log" handler in pool.ts.
 *
 * The `source` field preserves the namespace convention ([server], [cron],
 * [worker:PID], [webview:ID]) so logs stay grep-able and process-identifiable.
 *
 * Ref: node_modules/bun-types/docs/runtime/console.mdx
 */

export interface LogEntry {
  ts: number;
  source: string;
  level: "info" | "warn" | "error";
  msg: string;
  data?: unknown;
}

const LOG_BUFFER_MAX = 1000;
const logBuffer: LogEntry[] = [];

/**
 * Structured logger — writes to stdout AND in-memory ring buffer.
 * `source` is the namespace prefix (e.g. "server", "cron", "worker:12345").
 */
export function log(source: string, level: LogEntry["level"], msg: string, data?: unknown): void {
  const entry: LogEntry = { ts: Date.now(), source, level, msg, data };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  const icon = level === "error" ? "❌" : level === "warn" ? "⚠️" : "ℹ️";
  console.log(`${icon} [${new Date(entry.ts).toISOString()}] [${source}] ${msg}`, data ?? "");
}

/** Return up to `limit` recent entries from the ring buffer. */
export function getLogs(limit = 50): LogEntry[] {
  return logBuffer.slice(-limit);
}

/** Total entries currently in the buffer. */
export function getLogCount(): number {
  return logBuffer.length;
}
