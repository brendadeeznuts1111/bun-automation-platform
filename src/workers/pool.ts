/**
 * Worker pool — pre-spawned Bun processes with IPC.
 *
 * Uses node:child_process.fork() for reliable IPC (Bun.spawn({ ipc: true })
 * has a known issue where the IPC channel doesn't open in v1.3.14).
 *
 * Tasks are dispatched via child.send(taskId) and results are received
 * via child.on("message", ...).
 */

import { fork, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { trackWorker, isShuttingDown } from "../utils/shutdown";

const POOL_SIZE = parseInt(process.env.WORKER_POOL_SIZE ?? "4", 10);
const WORKER_SCRIPT = resolve(import.meta.dir, "../workers/task-worker.ts");

interface PendingTask {
  taskId: number;
  resolve: (result: unknown) => void;
  reject: (err: unknown) => void;
}

interface WorkerSlot {
  proc: ChildProcess;
  busy: boolean;
  currentTask: PendingTask | null;
  untrack: () => void;
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
  const proc = fork(
    process.execPath,
    [WORKER_SCRIPT],
    {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: {
        ...process.env,
        // Strip --hot to prevent event loop hang in child
        BUN_OPTIONS: undefined,
      },
    },
  );

  const slot: WorkerSlot = {
    proc,
    busy: false,
    currentTask: null,
    untrack: () => {},
  };

  // Track for graceful shutdown
  slot.untrack = trackWorker({
    pid: proc.pid!,
    send: (msg) => proc.send(msg),
    exited: new Promise<number>((resolve) => proc.on("exit", (code) => resolve(code ?? 0))),
    kill: (sig) => {
      try {
        proc.kill(sig as any);
      } catch {}
    },
  });

  // Handle messages from worker
  proc.on("message", (msg: any) => {
    handleWorkerMessage(slot, msg);
  });

  // Handle worker exit — only respawn if the process actually ran for a while
  let exited = false;
  proc.on("exit", (code, signal) => {
    if (exited) return;
    exited = true;
    slot.untrack();

    if (slot.currentTask) {
      if (code === 0) {
        slot.currentTask.resolve({ status: "completed" });
      } else {
        slot.currentTask.reject(new Error(`worker exited with code ${code} signal ${signal}`));
      }
      slot.currentTask = null;
    }

    slot.busy = false;

    // Respawn if not shutting down
    if (!isShuttingDown()) {
      const idx = pool.indexOf(slot);
      if (idx >= 0) {
        pool[idx] = spawnWorker();
        console.log(`[workers] respawned worker at index ${idx} (code=${code} signal=${signal})`);
      }
    }
  });

  return slot;
}

function handleWorkerMessage(slot: WorkerSlot, msg: any): void {
  if (!slot.currentTask) return;

  switch (msg.type) {
    case "progress":
      console.log(`[worker:${slot.proc.pid}] task ${msg.taskId} progress: ${msg.progress}%`);
      break;
    case "result":
      slot.currentTask.resolve(msg.result);
      slot.currentTask = null;
      slot.busy = false;
      dispatchNext();
      break;
    case "error":
      slot.currentTask.reject(new Error(msg.error));
      slot.currentTask = null;
      slot.busy = false;
      dispatchNext();
      break;
  }
}

function dispatchNext(): void {
  if (taskQueue.length === 0 || isShuttingDown()) return;

  const idle = pool.find((s) => !s.busy);
  if (!idle) return;

  const task = taskQueue.shift()!;
  idle.busy = true;
  idle.currentTask = task;
  idle.proc.send({ type: "task", taskId: task.taskId });
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
  const busy = pool.filter((s) => s.busy).length;
  return {
    total: pool.length,
    busy,
    idle: pool.length - busy,
    queued: taskQueue.length,
  };
}
