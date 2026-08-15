/**
 * Worker pool — pre-spawned Bun processes with native IPC.
 *
 * Uses Bun.spawn({ ipc: (message) => ... }) for parent-child IPC.
 * The child uses process.send() and process.on("message") — same as
 * Node.js child_process.fork().
 *
 * C4: Now uses the typed Channel interface (src/channels/ipc-channel.ts)
 * instead of raw proc.send(). This provides:
 *   - Type-safe message dispatch via channel.on("type", handler)
 *   - Unified interface across IPC, WebSocket, and MessagePort transports
 *   - Automatic cleanup on channel close
 *
 * The v1.3.14 GC leak fix for ipc subprocesses makes this safe.
 * Messages are serialized with the JSC serialize API (structuredClone-compatible).
 */

import { resolve } from "node:path";
import { trackWorker, isShuttingDown } from "../utils/shutdown";
import type { WorkerToParentMessage, ParentToWorkerMessage } from "../types/ipc";
import { IPCChannel } from "../channels/ipc-channel";
import type { Channel } from "../types/channel";

const POOL_SIZE = parseInt(process.env.WORKER_POOL_SIZE ?? "4", 10);
const WORKER_SCRIPT = resolve(import.meta.dir, "../workers/task-worker.ts");

interface PendingTask {
  taskId: number;
  resolve: (result: unknown) => void;
  reject: (err: unknown) => void;
}

interface WorkerSlot {
  // N2: proc is assigned synchronously in spawnWorker() before the slot is
  // returned. Using `| undefined` + a runtime check would be cleaner but
  // every consumer (handleWorkerMessage, dispatchNext, getPoolStatus) would
  // need to handle undefined. Since spawnWorker() always assigns proc before
  // returning, we keep it non-optional and cast at the assignment site.
  proc: import("bun").Subprocess<"ignore", "inherit", "inherit">;
  // C4: Typed channel for sending/receiving IPC messages
  channel: Channel<ParentToWorkerMessage, WorkerToParentMessage>;
  busy: boolean;
  currentTask: PendingTask | null;
  untrack: () => void;
  exited: boolean;
}

const pool: WorkerSlot[] = [];
const taskQueue: PendingTask[] = [];

// C7: WebSocket publish hook — set by server.ts when WebSocket is enabled.
// When set, worker messages are published to WebSocket subscribers.
type WSPublisher = (topic: string, msg: unknown) => void;
let wsPublisher: WSPublisher | null = null;

/**
 * Set the WebSocket publisher function.
 * Called by server.ts when ENABLE_WEBSOCKET=1 to relay worker messages
 * to connected WebSocket clients via pub/sub.
 */
export function setWSPublisher(publisher: WSPublisher | null): void {
  wsPublisher = publisher;
}

/**
 * Publish a message to WebSocket subscribers (if enabled).
 * Called from registerHandlers when worker messages arrive.
 */
function publishToWebSocket(topic: string, msg: unknown): void {
  if (wsPublisher) {
    try {
      wsPublisher(topic, msg);
    } catch (err) {
      console.error(`[workers] WebSocket publish failed for ${topic}:`, err);
    }
  }
}

/** Initialize the worker pool. */
export async function initWorkerPool(): Promise<void> {
  for (let i = 0; i < POOL_SIZE; i++) {
    const slot = spawnWorker();
    pool.push(slot);
  }
  console.log(`[workers] pool initialized with ${POOL_SIZE} workers`);
}

function spawnWorker(): WorkerSlot {
  // N2: proc is assigned after Bun.spawn() returns. We use a partial slot
  // and cast to WorkerSlot — proc and channel are set before the slot is used.
  const slot = {
    busy: false,
    // JUSTIFIED: null is valid for PendingTask | null; TS infers null type
    currentTask: null as PendingTask | null,
    untrack: () => {},
    exited: false,
    // JUSTIFIED: proc and channel are assigned below before slot is returned/used
  } as WorkerSlot;

  // C4: Create the IPC channel — messages are dispatched via handleMessage
  const channel = new IPCChannel<ParentToWorkerMessage, WorkerToParentMessage>(
    `worker-pending`,
    // JUSTIFIED: proc doesn't exist yet, but IPCChannel only uses it in send()
    // and handleMessage() which are called after proc is assigned below.
    {} as import("bun").Subprocess<"ignore", "inherit", "inherit">,
  );
  slot.channel = channel;

  const proc = Bun.spawn({
    cmd: [process.execPath, WORKER_SCRIPT],
    ipc: (message: WorkerToParentMessage) => {
      // C4: Dispatch through the typed channel
      channel.handleMessage(message);
    },
    onDisconnect: () => {
      // IPC channel closed — child exited or called disconnect
      channel.handleClose?.();
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
      // P1: --no-orphans — automatically exit when the parent process dies,
      // even if the parent is SIGKILLed and never sends a shutdown signal.
      // On Linux: prctl(PR_SET_PDEATHSIG, SIGKILL) — kernel-delivered, no polling.
      // On macOS: kqueue EVFILT_PROC NOTE_EXIT — same mechanism as child process watching.
      // The flag is inherited by nested Bun processes, so workers' subprocesses
      // (Bun.WebView Chrome processes) also die when the server dies.
      // Ref: https://bun.sh/blog/bun-v1.3.14#no-orphans-exit-when-the-parent-process-dies
      BUN_FEATURE_FLAG_NO_ORPHANS: "1",
    },
  });

  slot.proc = proc;
  // C4: Now that proc exists, update the channel's sender to the real proc
  // and set the proper id.
  channel.setSender?.(proc);
  channel.setId?.(`worker-${proc.pid}`);

  // C4: Register typed message handlers on the channel
  registerHandlers(slot);

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

// C4: Register typed message handlers on the channel instead of a switch.
// This is called once per worker slot after the channel is created.
function registerHandlers(slot: WorkerSlot): void {
  const { channel } = slot;

  channel.on("ready", () => {
    // Worker is ready — nothing to do, it's already in the pool
  });

  channel.on("progress", (msg) => {
    console.log(`[worker:${slot.proc.pid}] task ${msg.taskId} progress: ${msg.progress}%`);
    // C7: Publish to WebSocket subscribers if enabled
    publishToWebSocket(`task:${msg.taskId}`, {
      type: "progress",
      taskId: msg.taskId,
      progress: msg.progress,
      retrying: msg.retrying,
    });
  });

  channel.on("result", (msg) => {
    slot.currentTask?.resolve(msg.result);
    slot.currentTask = null;
    slot.busy = false;
    // C7: Publish to WebSocket subscribers
    publishToWebSocket(`task:${msg.taskId}`, {
      type: "result",
      taskId: msg.taskId,
      result: msg.result,
    });
    dispatchNext();
  });

  channel.on("error", (msg) => {
    slot.currentTask?.reject(new Error(msg.error));
    slot.currentTask = null;
    slot.busy = false;
    // C7: Publish to WebSocket subscribers
    publishToWebSocket(`task:${msg.taskId}`, {
      type: "error",
      taskId: msg.taskId,
      error: msg.error,
    });
    dispatchNext();
  });
}

function dispatchNext(): void {
  if (taskQueue.length === 0 || isShuttingDown()) return;

  const idle = pool.find((s) => !s.busy && !s.exited);
  if (!idle) return;

  const task = taskQueue.shift()!;
  idle.busy = true;
  idle.currentTask = task;

  // C4: Use the typed channel instead of raw proc.send()
  // E7: channel.send() returns false if IPC is closed — reject the task
  const sent = idle.channel.send({ type: "task", taskId: task.taskId });
  if (!sent) {
    console.error(`[workers] failed to send task to worker (IPC closed)`);
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
