/**
 * Type-safe IPC messages between main server process and worker subprocesses.
 *
 * The `log` message type lets workers send structured log entries to the
 * server's ring buffer (workers run in separate processes and can't share
 * the server's in-memory logBuffer). The server relays these via its
 * exported `log()` function so they appear in /api/logs.
 * Ref: https://bun.com/docs/runtime/spawn#ipc
 */

export type ParentToWorkerMessage =
  | { type: "task"; taskId: number }
  | { type: "shutdown"; reason?: string };

export type WorkerToParentMessage =
  | { type: "ready"; pid: number }
  | { type: "progress"; taskId: number; progress: number; retrying?: number }
  | { type: "result"; taskId: number; result: string }
  | { type: "error"; taskId: number; error: string }
  | { type: "log"; source: string; level: "info" | "warn" | "error"; msg: string; data?: unknown };
