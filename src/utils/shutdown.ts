/**
 * Graceful shutdown manager.
 *
 * Listens for SIGTERM/SIGINT and coordinates shutdown:
 * 1. Stop accepting new connections (server.stop())
 * 2. Send shutdown signal to all active workers via IPC
 * 3. Wait for workers to finish (with timeout)
 * 4. Close database connections
 * 5. Exit process
 */

import type { Server } from "bun";

type AnyServer = Server<any>;

import { closeDB } from "../db";

interface WorkerHandle {
  pid: number;
  send: (msg: unknown) => void;
  exited: Promise<number>;
  kill: (signal?: number | NodeJS.Signals) => void;
}

const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? "30000", 10);

const activeWorkers = new Set<WorkerHandle>();
let shuttingDown = false;

/** Register a worker for coordinated shutdown. */
export function trackWorker(worker: WorkerHandle): () => void {
  activeWorkers.add(worker);
  return () => activeWorkers.delete(worker);
}

/** Check if the server is shutting down. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Initiate graceful shutdown.
 * Called automatically on SIGTERM/SIGINT, or manually.
 */
export async function shutdown(server: AnyServer, reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[shutdown] initiated: ${reason}`);
  console.log(`[shutdown] ${activeWorkers.size} active workers`);

  // 1. Stop accepting new connections — graceful (allow in-flight to complete).
  // m6: Use server.stop() without force=true. The SHUTDOWN_TIMEOUT_MS below
  // ensures we don't hang forever waiting for slow requests.
  server.stop();

  // 2. Send shutdown signal to all workers
  const workerPromises: Promise<number>[] = [];
  for (const worker of activeWorkers) {
    try {
      worker.send({ type: "shutdown", reason });
    } catch {
      // Worker may have already exited
    }
    workerPromises.push(worker.exited);
  }

  // 3. Wait for workers with timeout
  // M6: Use Bun.sleep instead of setTimeout wrapper — native API, no timer leak
  // (Promise.race resolves when either settles; the sleep just becomes garbage)
  if (workerPromises.length > 0) {
    const timeout = Bun.sleep(SHUTDOWN_TIMEOUT_MS);
    const workersDone = Promise.allSettled(workerPromises).then(() => {});

    await Promise.race([workersDone, timeout]);

    // Kill any workers that didn't exit
    for (const worker of activeWorkers) {
      try {
        worker.kill("SIGKILL");
      } catch {
        // Already dead
      }
    }
  }

  // 4. Close database
  try {
    closeDB();
    console.log("[shutdown] database closed");
  } catch (e) {
    console.error("[shutdown] error closing database:", e);
  }

  console.log("[shutdown] complete");
  process.exit(0);
}

/**
 * Prepare for process replacement via execve().
 * Performs the same cleanup as shutdown() (stop server, notify workers, close DB)
 * but does NOT call process.exit() — the caller is expected to call execve()
 * immediately after this returns to replace the process image.
 *
 * Ref: bun-v1.3.14 blog — process.execve() support
 *
 * @param server - The Bun.serve server instance to stop
 * @param timeoutMs - Max time to wait for workers (default: SHUTDOWN_TIMEOUT_MS)
 */
export async function prepareForExecve(server: AnyServer, timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log("[shutdown] preparing for execve — graceful cleanup before process replacement");

  // 1. Stop accepting new connections
  server.stop();

  // 2. Notify workers
  const workerPromises: Promise<number>[] = [];
  for (const worker of activeWorkers) {
    try {
      worker.send({ type: "shutdown", reason: "execve — process replacement" });
    } catch {
      // Worker may have already exited
    }
    workerPromises.push(worker.exited);
  }

  // 3. Wait for workers with timeout
  if (workerPromises.length > 0) {
    const timeout = Bun.sleep(timeoutMs);
    const workersDone = Promise.allSettled(workerPromises).then(() => {});
    await Promise.race([workersDone, timeout]);

    // Kill any workers that didn't exit
    for (const worker of activeWorkers) {
      try {
        worker.kill("SIGKILL");
      } catch {
        // Already dead
      }
    }
  }

  // 4. Close database
  try {
    closeDB();
    console.log("[shutdown] database closed");
  } catch (e) {
    console.error("[shutdown] error closing database:", e);
  }

  console.log("[shutdown] cleanup complete — ready for execve");
}

/** Install signal handlers for graceful shutdown. */
export function installShutdownHandlers(server: AnyServer): void {
  const handler = (signal: string) => {
    shutdown(server, `received ${signal}`).catch((e) => {
      console.error("[shutdown] error:", e);
      process.exit(1);
    });
  };

  process.on("SIGTERM", () => handler("SIGTERM"));
  process.on("SIGINT", () => handler("SIGINT"));

  // SIGHUP on Unix, SIGBREAK on Windows — console close / terminal disconnect
  // Ref: bun-v1.3.14 blog — SIGHUP and SIGBREAK signal handling on Windows
  process.on("SIGHUP", () => handler("SIGHUP"));
  // SIGBREAK is Windows-only (Ctrl+Break). Guard with platform check — on
  // Unix, registering an unsupported signal name may throw or be a no-op.
  // Use string form since SIGBREAK constant is not in bun-types.
  if (process.platform === "win32") {
    // JUSTIFIED: SIGBREAK not in bun-types — string cast to NodeJS.Signals
    process.on("SIGBREAK" as NodeJS.Signals, () => handler("SIGBREAK"));
  }
}
