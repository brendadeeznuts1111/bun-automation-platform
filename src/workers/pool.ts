/**
 * Worker pool — pre-spawned Bun processes with native IPC.
 *
 * Uses Bun.spawn({ ipc: (message) => ... }) for parent-child IPC.
 * The child uses process.send() and process.on("message") — same as
 * Node.js child_process.fork().
 *
 * The v1.3.14 GC leak fix for ipc subprocesses makes this safe.
 * Messages are serialized with the JSC serialize API (structuredClone-compatible).
 */

import { resolve } from "node:path";
import { trackWorker, isShuttingDown } from "../utils/shutdown";
import type { WorkerToParentMessage } from "../types/ipc";

const POOL_SIZE = parseInt(process.env.WORKER_POOL_SIZE ?? "4", 10);
const WORKER_SCRIPT = resolve(import.meta.dir, "../workers/task-worker.ts");

interface PendingTask {
  taskId: number;
  resolve: (result: unknown) => void;
  reject: (err: unknown) => void;
}

interface WorkerSlot {
  proc: import("bun").Subprocess<"ignore", "inherit", "inherit">;
  busy: boolean;
  currentTask: PendingTask | null;
  untrack: () => void;
  exited: boolean;
}

const pool: WorkerSlot[] = [];
const taskQueue: PendingTask[] = [];

/** Initialize the worker pool. */
export async function initWorkerPool(): Promise<void> {
  for (let i = 0; i < POOL_SIZE; i++) {
    const slot = spawnWorker();
    pool.push(slot);
  }
  console.log(`[workers] pool initialized with ${POOL_SIZE} workers`);
}

function spawnWorker(): WorkerSlot {
  const slot: WorkerSlot = {
    proc: undefined!,
    busy: false,
    currentTask: null,
    untrack: () => {},
    exited: false,
  };

  const proc = Bun.spawn({
    cmd: [process.execPath, WORKER_SCRIPT],
    ipc: (message: WorkerToParentMessage) => {
      handleWorkerMessage(slot, message);
    },
    onDisconnect: () => {
      // IPC channel closed — child exited or called disconnect
    },
    // M2: onExit gives us signalCode + error for better diagnostics
    // (proc.exited.then only provides exitCode)
    onExit(_proc, exitCode, signalCode, error) {
      if (error) {
        console.error(`[workers] worker exited with error:`, error.message);
      }
      if (signalCode) {
        console.log(`[workers] worker killed by signal ${signalCode} (code=${exitCode})`);
      }
    },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      // Strip --hot to prevent event loop hang in child
      BUN_OPTIONS: undefined,
    },
  });

  slot.proc = proc;

  // Track for graceful shutdown
  slot.untrack = trackWorker({
    pid: proc.pid,
    send: (msg) => proc.send(msg),
    exited: proc.exited,
    kill: (sig) => {
      try {
        proc.kill(sig);
      } catch {}
    },
  });

  // Handle worker exit
  proc.exited.then((code) => {
    if (slot.exited) return;
    slot.exited = true;
    slot.untrack();

    // D1: If a new task was dispatched to this slot between the "result" message
    // and the exit, that task was sent to a now-dead worker. Reject it so the
    // caller (server.ts submitTask.catch) can log the failure. The task stays
    // "running" in the DB — the server should mark it as failed.
    if (slot.currentTask) {
      if (code === 0) {
        slot.currentTask.resolve({ status: "completed" });
      } else {
        slot.currentTask.reject(new Error(`worker exited with code ${code}`));
      }
      slot.currentTask = null;
    }

    slot.busy = false;

    // Respawn if not shutting down
    if (!isShuttingDown()) {
      const idx = pool.indexOf(slot);
      if (idx >= 0) {
        pool[idx] = spawnWorker();
        console.log(`[workers] respawned worker at index ${idx} (code=${code})`);
        // D1: Dispatch queued tasks to the freshly respawned worker
        dispatchNext();
      }
    }
  });

  return slot;
}

function handleWorkerMessage(slot: WorkerSlot, msg: WorkerToParentMessage): void {
  if (!slot.currentTask && msg.type !== "ready") return;

  switch (msg.type) {
    case "ready":
      // Worker is ready — nothing to do, it's already in the pool
      break;
    case "progress":
      console.log(`[worker:${slot.proc.pid}] task ${msg.taskId} progress: ${msg.progress}%`);
      break;
    case "result":
      slot.currentTask?.resolve(msg.result);
      slot.currentTask = null;
      slot.busy = false;
      dispatchNext();
      break;
    case "error":
      slot.currentTask?.reject(new Error(msg.error));
      slot.currentTask = null;
      slot.busy = false;
      dispatchNext();
      break;
  }
}

function dispatchNext(): void {
  if (taskQueue.length === 0 || isShuttingDown()) return;

  const idle = pool.find((s) => !s.busy && !s.exited);
  if (!idle) return;

  const task = taskQueue.shift()!;
  idle.busy = true;
  idle.currentTask = task;

  // E7: Catch proc.send() errors — if the IPC channel is closed, reject the
  // task immediately instead of leaving it stuck in currentTask forever.
  try {
    idle.proc.send({ type: "task", taskId: task.taskId });
  } catch (err) {
    console.error(`[workers] failed to send task to worker (IPC closed):`, err);
    idle.busy = false;
    idle.currentTask = null;
    task.reject(new Error("worker IPC channel closed"));
    // Try dispatching to another worker
    dispatchNext();
  }
}

/** Submit a task to the worker pool. Returns a promise that resolves with the result. */
export function submitTask(taskId: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const task: PendingTask = { taskId, resolve, reject };
    taskQueue.push(task);
    dispatchNext();
  });
}

/** Get pool status for health checks. */
export function getPoolStatus(): { total: number; busy: number; idle: number; queued: number } {
  // E8: Exclude exited workers from the idle count — they can't accept tasks.
  const active = pool.filter((s) => !s.exited);
  const busy = active.filter((s) => s.busy).length;
  return {
    total: pool.length,
    busy,
    idle: active.length - busy,
    queued: taskQueue.length,
  };
}
