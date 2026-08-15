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
 * Auth (B1) + CSRF (B2) middleware on all protected routes.
 */

import type { BunRequest } from "bun";
import { migrate, read, write } from "./db";
import { audit, getAuditLog } from "./db/audit";
import { checkRateLimit, cleanupRateLimits } from "./middleware/rate-limit";
import { handlePreflight, withCors } from "./middleware/cors";
import { verifyAuth, type AuthContext } from "./middleware/auth";
import { generateCsrfToken, checkCsrf } from "./middleware/csrf";
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

// --- Helpers ---------------------------------------------------------------

function getClientIP(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorResponse(msg: string, status: number): Response {
  return Response.json({ error: msg }, { status });
}

type RouteHandler<T extends string> = (req: BunRequest<T>) => Response | Promise<Response>;

/**
 * Base middleware: rate limiting + CORS.
 * Applied to all routes.
 */
function withMiddleware<T extends string>(
  handler: RouteHandler<T>,
): RouteHandler<T> {
  return async (req) => {
    const ip = getClientIP(req);
    const path = new URL(req.url).pathname;

    const rl = await checkRateLimit(ip, path);
    if (!rl.allowed) {
      return withCors(req, errorResponse("Too Many Requests", 429));
    }

    const res = await handler(req);
    return withCors(req, res);
  };
}

/**
 * Auth-required middleware: rejects 401 if no valid session.
 * Passes the AuthContext to the handler via a closure.
 */
function withAuth<T extends string>(
  handler: (req: BunRequest<T>, ctx: AuthContext) => Response | Promise<Response>,
): RouteHandler<T> {
  return withMiddleware(async (req) => {
    const ctx = verifyAuth(req);
    if (!ctx) {
      return errorResponse("unauthorized", 401);
    }
    return handler(req, ctx);
  });
}

/**
 * CSRF-protected middleware: requires auth + valid CSRF token.
 * Use on state-changing routes (POST/PUT/DELETE).
 */
function withCsrf<T extends string>(
  handler: (req: BunRequest<T>, ctx: AuthContext) => Response | Promise<Response>,
): RouteHandler<T> {
  return withAuth(async (req, ctx) => {
    if (!checkCsrf(req, String(ctx.sessionId))) {
      return errorResponse("invalid csrf token", 403);
    }
    return handler(req, ctx);
  });
}

// --- Route Handlers --------------------------------------------------------

const healthHandler = withMiddleware((): Response => {
  const pool = getPoolStatus();
  return json({
    status: "ok",
    uptime: process.uptime(),
    version: Bun.version,
    workers: pool,
    shuttingDown: isShuttingDown(),
  });
});

const metricsHandler = withMiddleware((): Response => {
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
});

const loginHandler = withMiddleware<"">(async (req) => {
  try {
    const body = await req.json() as { username: string; password: string };

    if (!body.username || !body.password) {
      return errorResponse("username and password required", 400);
    }

    const ip = getClientIP(req);
    const agent = read((db) => {
      return db.query("SELECT id, username, password FROM agents WHERE username = ?").get(body.username) as
        | { id: number; username: string; password: string }
        | null;
    });

    if (!agent) {
      await audit({ action: "login_failed", resource: body.username, ip_address: ip });
      return errorResponse("invalid credentials", 401);
    }

    const valid = await Bun.password.verify(body.password, agent.password);
    if (!valid) {
      await audit({ action: "login_failed", resource: body.username, ip_address: ip });
      return errorResponse("invalid credentials", 401);
    }

    await audit({ agent_id: agent.id, action: "login_success", ip_address: ip });

    // Create session: auth token (random UUID) + CSRF token (HMAC-signed, bound to session ID)
    const authToken = crypto.randomUUID();

    const sessionId = await write((db) => {
      // Insert with a placeholder CSRF token first to get the session ID
      const result = db.query(
        `INSERT INTO auth_sessions (agent_id, token, csrf_token)
         VALUES (?, ?, '')`,
      ).run(agent.id, authToken);
      return Number(result.lastInsertRowid);
    });

    // Generate CSRF token bound to the session ID for cross-user replay prevention
    const csrfToken = generateCsrfToken(String(sessionId));

    await write((db) => {
      db.query("UPDATE auth_sessions SET csrf_token = ? WHERE id = ?").run(csrfToken, sessionId);
    });

    return json({ token: authToken, csrf_token: csrfToken, agent_id: agent.id, username: agent.username });
  } catch {
    return errorResponse("invalid request body", 400);
  }
});

const listTasksHandler = withAuth<"">((req) => {
  const url = new URL(req.url);
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

  return json({ tasks, total, limit, offset });
});

const createTaskHandler = withCsrf<"">(async (req, _ctx) => {
  try {
    const body = await req.json() as {
      agent_id: number;
      url: string;
      proxy?: string;
      user_agent?: string;
      priority?: number;
    };

    if (!body.url || !body.agent_id) {
      return errorResponse("agent_id and url are required", 400);
    }

    // Validate URL
    try {
      new URL(body.url);
    } catch {
      return errorResponse("invalid url", 400);
    }

    const ip = getClientIP(req);
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

    return json({ id: taskId, status: "pending" }, 201);
  } catch {
    return errorResponse("invalid request body", 400);
  }
});

const getTaskHandler = withAuth<"/task/:id">((req) => {
  const taskId = parseInt(req.params.id, 10);
  const task = read((db) => {
    return db.query("SELECT * FROM tasks WHERE id = ?").get(taskId);
  });

  if (!task) return errorResponse("task not found", 404);
  return json(task);
});

const listSessionsHandler = withAuth<"">((req) => {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);

  const sessions = read((db) => {
    return db.query(
      `SELECT id, task_id, screenshot_path, screenshot_color, expires_at, last_healthy, created_at
       FROM sessions ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(limit, offset);
  });

  return json({ sessions, limit, offset });
});

const getScreenshotHandler = withAuth<"/screenshot/:id">((req) => {
  const sessionId = parseInt(req.params.id, 10);
  const session = read((db) => {
    return db.query("SELECT screenshot_path FROM sessions WHERE id = ?").get(sessionId) as
      | { screenshot_path: string }
      | null;
  });

  if (!session) return errorResponse("session not found", 404);
  if (!session.screenshot_path) return errorResponse("no screenshot for this session", 404);

  // Optional resize + format query params
  const url = new URL(req.url);
  const width = url.searchParams.get("w") ? parseInt(url.searchParams.get("w")!, 10) : undefined;
  const format = (url.searchParams.get("format") as "webp" | "jpeg" | "png") ?? "webp";

  try {
    return serveScreenshot(session.screenshot_path, width, format);
  } catch {
    return errorResponse("screenshot file missing", 404);
  }
});

const auditHandler = withAuth<"">((req) => {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const agentId = url.searchParams.get("agent_id");

  const logs = getAuditLog(limit, offset, agentId ? parseInt(agentId, 10) : undefined);
  return json({ logs, limit, offset });
});

// --- Server ----------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  // WebView tasks can take 30+ seconds; default 10s would kill long handlers.
  // Max value is 255; 0 disables entirely (not recommended for production).
  idleTimeout: 255,

  routes: {
    // Public routes (no auth)
    "/health": { GET: healthHandler },
    "/metrics": { GET: metricsHandler },
    "/login": { POST: loginHandler },

    // Auth-required routes
    "/tasks": { GET: listTasksHandler },
    "/task": { POST: createTaskHandler },       // also requires CSRF
    "/task/:id": { GET: getTaskHandler },
    "/sessions": { GET: listSessionsHandler },
    "/screenshot/:id": { GET: getScreenshotHandler },
    "/audit": { GET: auditHandler },
  },

  // Fallback for unmatched routes + CORS preflight (OPTIONS)
  async fetch(req) {
    // CORS preflight for any route
    const preflight = handlePreflight(req);
    if (preflight) return preflight;

    return withCors(req, errorResponse("not found", 404));
  },
});

// --- Shutdown --------------------------------------------------------------

installShutdownHandlers(server);

console.log(`[server] listening on http://${HOST}:${PORT}`);
console.log(`[server] endpoints:`);
console.log(`  GET  /health         — health check + worker pool status (public)`);
console.log(`  GET  /metrics        — Prometheus-format metrics (public)`);
console.log(`  POST /login          — agent authentication → returns token + csrf_token`);
console.log(`  GET  /tasks          — list tasks (auth required)`);
console.log(`  POST /task           — create task (auth + CSRF required)`);
console.log(`  GET  /task/:id       — get task by ID (auth required)`);
console.log(`  GET  /sessions       — list sessions (auth required)`);
console.log(`  GET  /screenshot/:id — serve screenshot (auth required)`);
console.log(`  GET  /audit          — audit log (auth required)`);
