#!/usr/bin/env bun
/**
 * Bun Automation Platform — Main Server
 *
 * Implements the Week 1 backlog priorities:
 * - Rate limiting (SQLite rolling-window)
 * - CORS restrictions
 * - Audit log
 * - Graceful shutdown (SIGTERM + IPC to workers)
 * - Retry logic (in workers)
 * - Health check endpoint
 * - Circuit breaker (in workers)
 *
 * Plus the worker pool for Week 3 scalability.
 */

import { migrate, read, write, closeDB } from "./db";
import { audit, getAuditLog } from "./db/audit";
import { checkRateLimit, cleanupRateLimits } from "./middleware/rate-limit";
import { handlePreflight, withCors } from "./middleware/cors";
import { installShutdownHandlers, isShuttingDown } from "./utils/shutdown";
import { initWorkerPool, submitTask, getPoolStatus } from "./workers/pool";
import { serveScreenshot } from "./utils/image";

// --- Config ----------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
const NODE_ENV = process.env.NODE_ENV ?? "development";

// --- Init ------------------------------------------------------------------

console.log(`[server] starting in ${NODE_ENV} mode on ${HOST}:${PORT}`);

// Run migrations
await migrate();
console.log("[server] database migrated");

// Initialize worker pool
await initWorkerPool();

// Periodic cleanup of old rate limit entries
setInterval(() => cleanupRateLimits(), 300_000); // every 5 min

// --- Helper: get client IP -------------------------------------------------

function getClientIP(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

// --- Helper: JSON response -------------------------------------------------

function json(data: unknown, status = 200, req?: Request): Response {
  const res = Response.json(data, { status });
  return req ? withCors(req, res) : res;
}

function error(msg: string, status: number, req?: Request): Response {
  const res = Response.json({ error: msg }, { status });
  return req ? withCors(req, res) : res;
}

// --- Routes ----------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  hostname: HOST,

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const ip = getClientIP(req);

    // CORS preflight
    const preflight = handlePreflight(req);
    if (preflight) return preflight;

    // Rate limiting
    const rl = checkRateLimit(ip, path);
    if (!rl.allowed) {
      return error("Too Many Requests", 429, req);
    }

    // --- Health check ------------------------------------------------------

    if (path === "/health" && method === "GET") {
      const pool = getPoolStatus();
      return json({
        status: "ok",
        uptime: process.uptime(),
        version: Bun.version,
        workers: pool,
        shuttingDown: isShuttingDown(),
      }, 200, req);
    }

    // --- Metrics (basic) ---------------------------------------------------

    if (path === "/metrics" && method === "GET") {
      const taskCounts = read((db) => {
        return db.query(
          `SELECT status, COUNT(*) as count FROM tasks GROUP BY status`,
        ).all() as { status: string; count: number }[];
      });

      const pool = getPoolStatus();
      const metrics = [
        ...taskCounts.map((t) => `tasks{status="${t.status}"} ${t.count}`),
        `workers{state="total"} ${pool.total}`,
        `workers{state="busy"} ${pool.busy}`,
        `workers{state="idle"} ${pool.idle}`,
        `workers{state="queued"} ${pool.queued}`,
        `process_uptime_seconds ${process.uptime()}`,
      ].join("\n");

      return new Response(metrics, {
        headers: { "Content-Type": "text/plain; version=0.0.4" },
      });
    }

    // --- Auth: Login -------------------------------------------------------

    if (path === "/login" && method === "POST") {
      try {
        const body = await req.json() as { username: string; password: string };

        if (!body.username || !body.password) {
          return error("username and password required", 400, req);
        }

        const agent = read((db) => {
          return db.query("SELECT id, username, password FROM agents WHERE username = ?").get(body.username) as
            | { id: number; username: string; password: string }
            | null;
        });

        if (!agent) {
          await audit({ action: "login_failed", resource: body.username, ip_address: ip });
          return error("invalid credentials", 401, req);
        }

        const valid = await Bun.password.verify(body.password, agent.password);
        if (!valid) {
          await audit({ action: "login_failed", resource: body.username, ip_address: ip });
          return error("invalid credentials", 401, req);
        }

        await audit({ agent_id: agent.id, action: "login_success", ip_address: ip });

        // Simple session token (in production, use signed JWT or similar)
        const token = btoa(`${agent.id}:${Date.now()}:${crypto.randomUUID()}`);
        return json({ token, agent_id: agent.id, username: agent.username }, 200, req);
      } catch (e) {
        return error("invalid request body", 400, req);
      }
    }

    // --- Tasks: List -------------------------------------------------------

    if (path === "/tasks" && method === "GET") {
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
      const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
      const status = url.searchParams.get("status");

      const tasks = read((db) => {
        if (status) {
          return db.query(
            `SELECT id, agent_id, url, status, progress, priority, error, created_at, updated_at, completed_at
             FROM tasks WHERE status = ? ORDER BY priority DESC, created_at DESC LIMIT ? OFFSET ?`,
          ).all(status, limit, offset);
        }
        return db.query(
          `SELECT id, agent_id, url, status, progress, priority, error, created_at, updated_at, completed_at
           FROM tasks ORDER BY priority DESC, created_at DESC LIMIT ? OFFSET ?`,
        ).all(limit, offset);
      });

      const total = read((db) => {
        const row = db.query("SELECT COUNT(*) as count FROM tasks").get() as { count: number };
        return row.count;
      });

      return json({ tasks, total, limit, offset }, 200, req);
    }

    // --- Tasks: Create -----------------------------------------------------

    if (path === "/task" && method === "POST") {
      try {
        const body = await req.json() as {
          agent_id: number;
          url: string;
          proxy?: string;
          user_agent?: string;
          priority?: number;
        };

        if (!body.url || !body.agent_id) {
          return error("agent_id and url are required", 400, req);
        }

        // Validate URL
        try {
          new URL(body.url);
        } catch {
          return error("invalid url", 400, req);
        }

        const taskId = await write((db) => {
          const result = db.query(
            `INSERT INTO tasks (agent_id, url, proxy, user_agent, priority)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(
            body.agent_id,
            body.url,
            body.proxy ?? null,
            body.user_agent ?? null,
            body.priority ?? 0,
          );
          return Number(result.lastInsertRowid);
        });

        await audit({ agent_id: body.agent_id, action: "task_created", resource: `task:${taskId}`, ip_address: ip });

        // Submit to worker pool (async — don't await)
        submitTask(taskId).catch((err) => {
          console.error(`[server] task ${taskId} failed:`, err);
        });

        return json({ id: taskId, status: "pending" }, 201, req);
      } catch (e) {
        return error("invalid request body", 400, req);
      }
    }

    // --- Tasks: Get by ID --------------------------------------------------

    const taskMatch = path.match(/^\/task\/(\d+)$/);
    if (taskMatch && method === "GET") {
      const taskId = parseInt(taskMatch[1], 10);
      const task = read((db) => {
        return db.query("SELECT * FROM tasks WHERE id = ?").get(taskId);
      });

      if (!task) return error("task not found", 404, req);
      return json(task, 200, req);
    }

    // --- Sessions: List ----------------------------------------------------

    if (path === "/sessions" && method === "GET") {
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
      const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

      const sessions = read((db) => {
        return db.query(
          `SELECT id, task_id, screenshot_path, screenshot_color, expires_at, last_healthy, created_at
           FROM sessions ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        ).all(limit, offset);
      });

      return json({ sessions, limit, offset }, 200, req);
    }

    // --- Screenshot: Serve by session ID -----------------------------------

    const screenshotMatch = path.match(/^\/screenshot\/(\d+)$/);
    if (screenshotMatch && method === "GET") {
      const sessionId = parseInt(screenshotMatch[1], 10);
      const session = read((db) => {
        return db.query("SELECT screenshot_path FROM sessions WHERE id = ?").get(sessionId) as
          | { screenshot_path: string }
          | null;
      });

      if (!session) return error("session not found", 404, req);
      if (!session.screenshot_path) return error("no screenshot for this session", 404, req);

      // Optional resize + format query params
      const width = url.searchParams.get("w") ? parseInt(url.searchParams.get("w")!, 10) : undefined;
      const format = (url.searchParams.get("format") as "webp" | "jpeg" | "png") ?? "webp";

      try {
        return serveScreenshot(session.screenshot_path, width, format);
      } catch {
        return error("screenshot file missing", 404, req);
      }
    }

    // --- Audit log ---------------------------------------------------------

    if (path === "/audit" && method === "GET") {
      const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
      const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
      const agentId = url.searchParams.get("agent_id");

      const logs = getAuditLog(limit, offset, agentId ? parseInt(agentId, 10) : undefined);
      return json({ logs, limit, offset }, 200, req);
    }

    // --- 404 ---------------------------------------------------------------

    return error("not found", 404, req);
  },
});

// --- Shutdown --------------------------------------------------------------

installShutdownHandlers(server);

console.log(`[server] listening on http://${HOST}:${PORT}`);
console.log(`[server] endpoints:`);
console.log(`  GET  /health       — health check + worker pool status`);
console.log(`  GET  /metrics      — Prometheus-format metrics`);
console.log(`  POST /login        — agent authentication`);
console.log(`  GET  /tasks        — list tasks (pagination + status filter)`);
console.log(`  POST /task         — create task (dispatches to worker pool)`);
console.log(`  GET  /task/:id     — get task by ID`);
console.log(`  GET  /sessions     — list sessions`);
console.log(`  GET  /screenshot/:id — serve screenshot (optional ?w=400&format=jpeg)`);
console.log(`  GET  /audit        — audit log (pagination + agent filter)`);
