/**
 * Type-safe IPC messages between main server process and worker subprocesses.
 */

export type ParentToWorkerMessage =
  | { type: "task"; taskId: number }
  | { type: "shutdown"; reason?: string };

export type WorkerToParentMessage =
  | { type: "ready"; pid: number }
  | { type: "progress"; taskId: number; progress: number; retrying?: number }
  | { type: "result"; taskId: number; result: string }
  | { type: "error"; taskId: number; error: string };
