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

  // 1. Stop accepting new connections (non-blocking stop, allow in-flight)
  server.stop(true); // stop = true to forcefully close after timeout

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
  if (workerPromises.length > 0) {
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS));
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

  // SIGHUP on Unix, SIGBREAK on Windows — console close
  process.on("SIGHUP", () => handler("SIGHUP"));
}
