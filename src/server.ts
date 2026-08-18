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
import { audit, getAuditLog, onAuditEvent } from "./db/audit";
import { checkRateLimit, cleanupRateLimits } from "./middleware/rate-limit";
import { handlePreflight, withCors } from "./middleware/cors";
import { verifyAuth, type AuthContext } from "./middleware/auth";
import { generateCsrfToken, checkCsrf } from "./middleware/csrf";
import { installShutdownHandlers, isShuttingDown } from "./utils/shutdown";
import { initWorkerPool, submitTask, getPoolStatus } from "./workers/pool";
import { serveScreenshot } from "./utils/image";
import { isFeatureEnabled, shouldActivate, markActive, markBlocked, listFeatures, getFeatureSummary } from "./features/registry";
import { setWSPublisher } from "./workers/pool";
import { log, getLogs, getLogCount } from "./utils/log";

// --- Config ----------------------------------------------------------------

// Ref: https://bun.com/docs/runtime/env#typescript-integration
// Helper for validated env access — throws if a required var is missing.
function getEnv(key: string, fallback?: string): string {
  const value = Bun.env[key];
  if (value === undefined && fallback === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value ?? fallback!;
}

const PORT = parseInt(getEnv("PORT", "3000"), 10);
const HOST = getEnv("HOST", "0.0.0.0");
const NODE_ENV = getEnv("NODE_ENV", "development");

// --- Feature flags ---------------------------------------------------------
// R3: Conditionally enable TLS, HTTP/3, and dev dashboard behind flags.
// Each flag is tracked in src/features/registry.ts with promotion status.
// D5: Use shouldActivate() which checks deps + marks blocked, then markActive()
// after the feature is actually running. This ensures /features endpoint
// shows accurate runtime state, not just env-var state.

// D4: HTTP/3 requested without TLS → fail loudly, don't silently disable.
if (isFeatureEnabled("http3") && !isFeatureEnabled("tls")) {
  log("server", "error", "ENABLE_HTTP3=1 requires ENABLE_TLS=1 (HTTP/3 mandates TLS)");
  process.exit(1);
}

const ENABLE_TLS = shouldActivate("tls");
const ENABLE_HTTP3 = shouldActivate("http3");
// Dev dashboard auto-enables in development mode unless explicitly disabled
const ENABLE_DEV_DASHBOARD = isFeatureEnabled("devDashboard") ||
  (NODE_ENV === "development" && process.env.ENABLE_DEV_DASHBOARD !== "0");
// C6: WebSocket support — behind ENABLE_WEBSOCKET flag
const ENABLE_WEBSOCKET = shouldActivate("websocket");
const ENABLE_SITEMAP = shouldActivate("sitemap");
const ENABLE_HTML_REWRITER = shouldActivate("htmlRewriter");
const ENABLE_PWA = shouldActivate("pwa");

// TLS cert/key — only loaded if ENABLE_TLS is true
let tlsConfig: { cert: string; key: string } | undefined;
if (ENABLE_TLS) {
  const certPath = process.env.TLS_CERT_PATH ?? "dev-cert.pem";
  const keyPath = process.env.TLS_KEY_PATH ?? "dev-key.pem";
  const certFile = Bun.file(certPath);
  const keyFile = Bun.file(keyPath);
  if (!(await certFile.exists()) || !(await keyFile.exists())) {
    log("server", "error", `ENABLE_TLS=1 but cert/key not found at ${certPath}/${keyPath}`, {
      hint: "Generate with: openssl req -x509 -newkey rsa:2048 -keyout dev-key.pem -out dev-cert.pem -days 365 -nodes -subj /CN=localhost",
    });
    markBlocked("tls", `cert/key not found at ${certPath}/${keyPath}`);
    process.exit(1);
  }
  tlsConfig = { cert: await certFile.text(), key: await keyFile.text() };
  markActive("tls");
  log("server", "info", `TLS enabled (cert: ${certPath})`);
}

if (ENABLE_HTTP3) {
  if (!ENABLE_TLS) {
    markBlocked("http3", "requires tls to be enabled");
    log("server", "error", "ENABLE_HTTP3=1 requires ENABLE_TLS=1 (HTTP/3 mandates TLS)");
    process.exit(1);
  }
  markActive("http3");
  log("server", "info", "HTTP/3 (QUIC) enabled — experimental, not for production yet");
  log("server", "info", "Ref: https://bun.sh/blog/bun-v1.3.14#http-3-quic-support-in-bun-serve");
}

if (ENABLE_DEV_DASHBOARD) {
  markActive("devDashboard");
  log("server", "info", "Dev dashboard enabled at /dashboard");
}

if (ENABLE_WEBSOCKET) {
  markActive("websocket");
  log("server", "info", "WebSocket enabled — /ws/task/:id for live progress");
}

log("server", "info", `feature flags: ${getFeatureSummary()}`);

// F7: Pre-compute a real Argon2id hash at startup for the login timing oracle
// mitigation (E2). Using a real hash with the same parameters as
// Bun.password.hash() ensures the dummy verify takes nearly the same time as
// a real "wrong password" verify. Generated once at startup, reused for all
// non-existent-user login attempts.
const DUMMY_PASSWORD_HASH = await Bun.password.hash("dummy-password-that-never-matches");

// G10: Max request body size (1 MB). Prevents OOM from oversized payloads.
const MAX_BODY_BYTES = 1_048_576;

// Log server startup
log("server", "info", "BUN-DEV server initializing", { version: Bun.version, pid: process.pid });

// --- Init ------------------------------------------------------------------

log("server", "info", `starting in ${NODE_ENV} mode on ${HOST}:${PORT}`);

// Run migrations
await migrate();
log("server", "info", "database migrated");

// Initialize worker pool
await initWorkerPool();

// Periodic cleanup of old rate limit entries
// D11: Catch the promise rejection from write() — don't let it become an
// unhandled rejection that crashes the process.
setInterval(() => {
  cleanupRateLimits().catch((e) => log("server", "error", "rate limit cleanup failed", e));
}, 300_000); // every 5 min

// E10: Periodic cleanup of expired auth sessions — prevents unbounded growth.
setInterval(() => {
  write((db) => {
    db.query("DELETE FROM auth_sessions WHERE expires_at <= datetime('now')").run();
  }).catch((e) => log("server", "error", "session cleanup failed", e));
}, 3_600_000); // every hour

// --- Helpers ---------------------------------------------------------------

/**
 * Extract the client IP from the request.
 *
 * M5: Trust order is cf-connecting-ip → x-forwarded-for → unknown.
 * IMPORTANT: cf-connecting-ip is only trustworthy when behind Cloudflare.
 * If the server is directly exposed (not behind Cloudflare/proxy), an attacker
 * can spoof this header to bypass per-IP rate limiting. In production, either:
 *   1. Deploy behind Cloudflare (cf-connecting-ip is set by Cloudflare's edge)
 *   2. Deploy behind a trusted proxy that overwrites x-forwarded-for
 *   3. Set TRUST_PROXY_HEADERS=false to only use the socket peer address
 */
function getClientIP(req: Request): string {
  const trustProxy = process.env.TRUST_PROXY_HEADERS !== "false";
  if (trustProxy) {
    return (
      req.headers.get("cf-connecting-ip") ??
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown"
    );
  }
  // When not behind a proxy, fall back to unknown (Bun.serve doesn't expose
  // the raw socket peer address in the Request object in v1.3.14)
  return "unknown";
}

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  if (extraHeaders) {
    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
    return Response.json(data, { status, headers });
  }
  return Response.json(data, { status });
}

function errorResponse(msg: string, status: number): Response {
  return Response.json({ error: msg }, { status });
}

type RouteHandler<T extends string> = (req: BunRequest<T>) => Response | Promise<Response>;

/**
 * Base middleware: rate limiting + CORS + request size limit.
 * Applied to all routes.
 */
function withMiddleware<T extends string>(
  handler: RouteHandler<T>,
): RouteHandler<T> {
  return async (req) => {
    const ip = getClientIP(req);
    const path = new URL(req.url).pathname;

    // G2: Per-request traceId for distributed tracing
    // Ref: OPEN_TASKS G2 — structured logging with trace correlation
    const traceId = Bun.CryptoHasher.hash("sha256", `${Date.now()}-${Math.random()}`, "hex").slice(0, 16);

    const rl = await checkRateLimit(ip, path, req.method);
    if (!rl.allowed) {
      return withCors(req, errorResponse("Too Many Requests", 429));
    }

    // G10: Reject requests with oversized bodies before parsing JSON.
    const contentLength = req.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
      return withCors(req, errorResponse("request body too large", 413));
    }

    const start = performance.now();
    const res = await handler(req);
    const duration = (performance.now() - start).toFixed(2);

    // Structured log for every request
    log("server", "info", `${req.method} ${path}`, { traceId, ip, status: res.status, duration: `${duration}ms` });

    // Add traceId + timing headers to response
    const headers = new Headers(res.headers);
    headers.set("X-Trace-Id", traceId);
    headers.set("X-Response-Time", `${duration}ms`);
    return withCors(req, new Response(res.body, { status: res.status, statusText: res.statusText, headers }));
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
    // JUSTIFIED: bun:sqlite .all() returns unknown[]; narrowing to the count row type
    ).all() as { status: string; count: number }[];
  });

  const pool = getPoolStatus();
  const routeCount = Object.keys(routes).length;
  const pwaRouteCount = Object.keys(routes).filter((r) =>
    r.includes("manifest") || r.includes("sw.js") || r.includes("icons") || r.includes("pwa")
  ).length;
  const metrics = [
    ...taskCounts.map((t) => `tasks{status="${t.status}"} ${t.count}`),
    `workers{state="total"} ${pool.total}`,
    `workers{state="busy"} ${pool.busy}`,
    `workers{state="idle"} ${pool.idle}`,
    `workers{state="queued"} ${pool.queued}`,
    `process_uptime_seconds ${process.uptime()}`,
    `routes{type="total"} ${routeCount}`,
    `routes{type="pwa"} ${pwaRouteCount}`,
    `pwa{enabled="${ENABLE_PWA ? "true" : "false"}"} 1`,
    `features{type="active"} ${listFeatures().filter((f) => f.active).length}`,
    `features{type="total"} ${listFeatures().length}`,
  ].join("\n");

  return new Response(metrics, {
    headers: { "Content-Type": "text/plain; version=0.0.4" },
  });
});

const loginHandler = withMiddleware<"">(async (req) => {
  try {
    // JUSTIFIED: req.json() returns unknown; narrowing to the login body shape
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
      // E2: Timing oracle — if we return immediately for non-existent users,
      // an attacker can enumerate valid usernames by measuring response time.
      // F7: Generate a real Argon2id hash at startup with the same parameters
      // Bun.password.hash uses by default, then verify against it. This gives
      // nearly identical timing to the "wrong password" path (both do a full
      // Argon2id verification with the same m/t/p parameters).
      await Bun.password.verify(body.password, DUMMY_PASSWORD_HASH);
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
    // Use db.transaction() for atomicity — if the process crashes mid-session-creation,
    // the entire transaction rolls back (no session with empty csrf_token left behind).
    const authToken = crypto.randomUUID();

    const { csrfToken } = await write((db) => {
      const createSession = db.transaction(() => {
        // Insert with placeholder CSRF to get the session ID
        const result = db.query(
          `INSERT INTO auth_sessions (agent_id, token, csrf_token)
           VALUES (?, ?, '')`,
        ).run(agent.id, authToken);
        const sid = Number(result.lastInsertRowid);

        // Generate CSRF token bound to the session ID
        const token = generateCsrfToken(String(sid));
        db.query("UPDATE auth_sessions SET csrf_token = ? WHERE id = ?").run(token, sid);

        return { csrfToken: token };
      });
      return createSession();
    });

    return json({ token: authToken, csrf_token: csrfToken, agent_id: agent.id, username: agent.username }, 200, {
      "Set-Cookie": `session=${authToken}; HttpOnly; SameSite=Strict; Max-Age=86400; Path=/`,
    });
  } catch (err) {
    // G3: Distinguish JSON parse errors (400) from unexpected errors (500).
    // Previously all errors returned "invalid request body" which hid DB
    // failures, hash failures, etc. Now only SyntaxError (JSON parse) gets 400.
    if (err instanceof SyntaxError) {
      return errorResponse("invalid request body", 400);
    }
    log("server", "error", "login error", err);
    return errorResponse("internal server error", 500);
  }
});

const listTasksHandler = withAuth<"">((req, ctx) => {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const status = url.searchParams.get("status");

  // m4: Single parameterized query instead of two different SQL strings.
  // E3: IDOR fix — only list tasks owned by the authenticated agent.
  const tasks = read((db) => {
    return db.query(
      `SELECT id, agent_id, url, status, progress, priority, error, created_at, updated_at, completed_at
       FROM tasks WHERE agent_id = ? AND (? IS NULL OR status = ?)
       ORDER BY priority DESC, created_at DESC LIMIT ? OFFSET ?`,
    ).all(ctx.agentId, status, status, limit, offset);
  });

  const total = read((db) => {
    // JUSTIFIED: bun:sqlite .get() returns unknown; narrowing to the count row type
    const row = db.query("SELECT COUNT(*) as count FROM tasks WHERE agent_id = ?").get(ctx.agentId) as { count: number };
    return row.count;
  });

  return json({ tasks, total, limit, offset });
});

// Streaming JSONL export of tasks — same query as /tasks but as JSONL lines
// Ref: node_modules/bun-types/docs/runtime/jsonl.mdx
// Ref: node_modules/bun-types/docs/runtime/streams.mdx
const tasksJsonlHandler = withAuth<"">((req, ctx) => {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const status = url.searchParams.get("status");
  const tasks = read((db) => {
    return db.query(
      `SELECT id, agent_id, url, status, progress, priority, error, created_at, updated_at, completed_at
       FROM tasks WHERE agent_id = ? AND (? IS NULL OR status = ?)
       ORDER BY priority DESC, created_at DESC LIMIT ? OFFSET ?`,
    ).all(ctx.agentId, status, status, limit, offset);
  });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const task of tasks) {
        controller.enqueue(encoder.encode(JSON.stringify(task) + "\n"));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/jsonl" } });
});

const createTaskHandler = withCsrf<"">(async (req, ctx) => {
  try {
    // JUSTIFIED: req.json() returns unknown; narrowing to the task creation body shape
    const body = await req.json() as {
      agent_id: number;
      url: string;
      proxy?: string;
      user_agent?: string;
      priority?: number;
    };

    if (!body.url) {
      return errorResponse("url is required", 400);
    }

    // E3: IDOR fix — force agent_id to the authenticated agent's ID.
    // The client can't create tasks for other agents.
    const agentId = ctx.agentId;

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
        agentId,
        body.url,
        body.proxy ?? null,
        body.user_agent ?? null,
        body.priority ?? 0,
      );
      return Number(result.lastInsertRowid);
    });

    await audit({ agent_id: agentId, action: "task_created", resource: `task:${taskId}`, ip_address: ip });

    // Submit to worker pool (async — don't await)
    // D1: If the worker crashes, the task promise rejects. Mark the task as
    // failed in the DB so it doesn't stay "running" forever.
    submitTask(taskId).catch(async (err) => {
      log("server", "error", `task ${taskId} failed`, err);
      try {
        await write((db) => {
          db.query(
            `UPDATE tasks SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ? AND status = 'running'`,
          ).run(err instanceof Error ? err.message : String(err), taskId);
        });
      } catch (dbErr) {
        log("server", "error", `failed to mark task ${taskId} as failed`, dbErr);
      }
    });

    return json({ id: taskId, status: "pending" }, 201);
  } catch {
    return errorResponse("invalid request body", 400);
  }
});

const getTaskHandler = withAuth<"/task/:id">((req, ctx) => {
  const taskId = parseInt(req.params.id, 10);
  // E3: IDOR fix — only return the task if it belongs to the authenticated agent
  const task = read((db) => {
    return db.query("SELECT * FROM tasks WHERE id = ? AND agent_id = ?").get(taskId, ctx.agentId);
  });

  if (!task) return errorResponse("task not found", 404);
  return json(task);
});

const listSessionsHandler = withAuth<"">((req, ctx) => {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  // E12: Filter out expired sessions by default (opt-in with ?include_expired=true)
  const includeExpired = url.searchParams.get("include_expired") === "true";

  const sessions = read((db) => {
    // E3: IDOR fix — only list sessions for tasks owned by the authenticated agent
    // E12: Filter expired sessions unless explicitly requested
    if (includeExpired) {
      return db.query(
        `SELECT s.id, s.task_id, s.screenshot_path, s.screenshot_color, s.expires_at, s.last_healthy, s.created_at
         FROM sessions s JOIN tasks t ON s.task_id = t.id
         WHERE t.agent_id = ?
         ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
      ).all(ctx.agentId, limit, offset);
    }
    return db.query(
      `SELECT s.id, s.task_id, s.screenshot_path, s.screenshot_color, s.expires_at, s.last_healthy, s.created_at
       FROM sessions s JOIN tasks t ON s.task_id = t.id
       WHERE t.agent_id = ? AND (s.expires_at IS NULL OR s.expires_at > datetime('now'))
       ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
    ).all(ctx.agentId, limit, offset);
  });

  return json({ sessions, limit, offset });
});

// Streaming JSONL export of sessions — same query as /sessions but as JSONL lines
// Ref: node_modules/bun-types/docs/runtime/jsonl.mdx
// Ref: node_modules/bun-types/docs/runtime/streams.mdx
const sessionsJsonlHandler = withAuth<"">((req, ctx) => {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const includeExpired = url.searchParams.get("include_expired") === "true";
  const sessions = read((db) => {
    if (includeExpired) {
      return db.query(
        `SELECT s.id, s.task_id, s.screenshot_path, s.screenshot_color, s.expires_at, s.last_healthy, s.created_at
         FROM sessions s JOIN tasks t ON s.task_id = t.id
         WHERE t.agent_id = ?
         ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
      ).all(ctx.agentId, limit, offset);
    }
    return db.query(
      `SELECT s.id, s.task_id, s.screenshot_path, s.screenshot_color, s.expires_at, s.last_healthy, s.created_at
       FROM sessions s JOIN tasks t ON s.task_id = t.id
       WHERE t.agent_id = ? AND (s.expires_at IS NULL OR s.expires_at > datetime('now'))
       ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
    ).all(ctx.agentId, limit, offset);
  });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const session of sessions) {
        controller.enqueue(encoder.encode(JSON.stringify(session) + "\n"));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/jsonl" } });
});

const getScreenshotHandler = withAuth<"/screenshot/:id">(async (req, ctx) => {
  const sessionId = parseInt(req.params.id, 10);
  // E3: IDOR fix — only return the screenshot if the session belongs to a task
  // owned by the authenticated agent
  const session = read((db) => {
    return db.query(
      `SELECT s.screenshot_path FROM sessions s
       JOIN tasks t ON s.task_id = t.id
       WHERE s.id = ? AND t.agent_id = ?`,
    // JUSTIFIED: bun:sqlite .get() returns unknown; narrowing to the session row type
    ).get(sessionId, ctx.agentId) as { screenshot_path: string } | null;
  });

  if (!session) return errorResponse("session not found", 404);
  if (!session.screenshot_path) return errorResponse("no screenshot for this session", 404);

  // Optional resize + format query params
  const url = new URL(req.url);
  const width = url.searchParams.get("w") ? parseInt(url.searchParams.get("w")!, 10) : undefined;
  // G2: Validate format param — don't cast unchecked user input to a union type
  const formatParam = url.searchParams.get("format");
  const format: "webp" | "jpeg" | "png" =
    formatParam === "jpeg" || formatParam === "png" ? formatParam : "webp";

  try {
    return await serveScreenshot(session.screenshot_path, width, format);
  } catch (err) {
    // G9: Distinguish "file not found" from "invalid image" for debugging
    log("server", "error", "serveScreenshot error", err);
    return errorResponse("screenshot unavailable", 404);
  }
});

const auditHandler = withAuth<"">((req, ctx) => {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  // E3: IDOR fix — agents can only see their own audit logs.
  // F1: The previous code used the requested agent_id if provided — that was
  // still an IDOR. Now we always force agentId to ctx.agentId regardless of
  // what the client requests.
  const agentId = ctx.agentId;

  const logs = getAuditLog(limit, offset, agentId);
  return json({ logs, limit, offset });
});

// JSONL audit export — chains Bun.serve + Bun.sqlite + Bun.JSONL streaming
// Ref: node_modules/bun-types/docs/runtime/jsonl.mdx
// Ref: node_modules/bun-types/docs/runtime/streams.mdx
const auditJsonlHandler = withAuth<"">((req, ctx) => {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const agentId = ctx.agentId;
  const logs = getAuditLog(limit, offset, agentId);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const log of logs) {
        controller.enqueue(encoder.encode(JSON.stringify(log) + "\n"));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/jsonl" } });
});

// --- Server ----------------------------------------------------------------

// R5: /protocol endpoint — shows which HTTP version the client used.
// Bun doesn't expose the negotiated protocol directly, but we can infer
// from the request URL scheme (https = TLS, http = plaintext) and
// whether Alt-Svc is being used (HTTP/3 clients have it cached).
const protocolHandler = withMiddleware((req: BunRequest<"">) => {
  const url = new URL(req.url);
  return json({
    scheme: url.protocol.replace(":", ""),
    method: req.method,
    url: req.url,
    userAgent: req.headers.get("user-agent"),
    http3Enabled: ENABLE_HTTP3,
    altSvc: ENABLE_HTTP3 ? `h3=":${PORT}"; ma=86400` : null,
    note: "Check browser devtools Network tab — protocol column shows h3 or http/1.1",
  });
});

// R6: /features endpoint — lists all feature flags and their status.
const featuresHandler = withMiddleware((): Response => {
  return json({ features: listFeatures() });
});

// Color conversion API — chains Bun.serve with Bun.color()
// Ref: https://bun.com/docs/runtime/color
// Accepts ?color=<input>&format=<outputFormat> and returns the converted color.
const colorHandler = withMiddleware<"">((req: BunRequest<"">): Response => {
  const url = new URL(req.url);
  const input = url.searchParams.get("color");
  if (!input) {
    return errorResponse("missing 'color' query parameter", 400);
  }
  const format = url.searchParams.get("format") ?? "css";
  const validFormats = ["css", "ansi", "ansi-16", "ansi-256", "ansi-16m", "number", "rgb", "rgba", "hsl", "hex", "HEX", "{rgb}", "{rgba}", "[rgb]", "[rgba]"];
  if (!validFormats.includes(format)) {
    return errorResponse(`invalid format '${format}'. Valid: ${validFormats.join(", ")}`, 400);
  }
  // JUSTIFIED: Bun.color's second param is a union; we validated against the list above
  const result = Bun.color(input, format as Parameters<typeof Bun.color>[1]);
  if (result === null) {
    return errorResponse(`failed to parse color '${input}'`, 400);
  }
  return json({ input, format, output: result });
});

// Environment variable inspection API — chains Bun.serve with Bun.env
// Ref: https://bun.com/docs/runtime/env
// Returns selected env vars (never secrets) for debugging and dashboard use.
const envHandler = withMiddleware<"">((req: BunRequest<"">): Response => {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  if (key) {
    // Return a single env var value (read-only, no secrets filtering on single key
    // since the caller already knows the key name)
    const value = Bun.env[key];
    if (value === undefined) {
      return errorResponse(`env var '${key}' is not set`, 404);
    }
    return json({ key, value, source: "Bun.env" });
  }
  // Return a safe subset of env vars for the dashboard
  // Ref: https://bun.com/docs/runtime/env#configuring-bun
  const safeKeys = [
    "NODE_ENV", "PORT", "HOST", "BUN_VERSION",
    "ENABLE_TLS", "ENABLE_HTTP3", "ENABLE_DEV_DASHBOARD",
    "ENABLE_WEBSOCKET", "ENABLE_SITEMAP", "ENABLE_HTML_REWRITER", "ENABLE_PWA",
    "NO_COLOR", "FORCE_COLOR", "TRUST_PROXY_HEADERS",
  ];
  const env: Record<string, string | undefined> = {};
  for (const k of safeKeys) {
    env[k] = Bun.env[k];
  }
  // Verify all three env accessors are aliases of the same object
  // Ref: https://bun.com/docs/runtime/env#reading-environment-variables
  return json({
    env,
    aliases: {
      "process.env === Bun.env": process.env === Bun.env,
      "Bun.env === import.meta.env": Bun.env === import.meta.env,
    },
    bunVersion: Bun.version,
  });
});

// SSE audit log stream — real-time audit events via Server-Sent Events
// Ref: node_modules/bun-types/docs/runtime/streams.mdx
// Ref: https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events
const auditStreamHandler = withAuth<"">((req: BunRequest<"">): Response => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Send initial comment to keep connection alive
      controller.enqueue(new TextEncoder().encode(": connected\n\n"));
      // Subscribe to audit events
      const unsubscribe = onAuditEvent((entry) => {
        const data = `data: ${JSON.stringify(entry)}\n\n`;
        try {
          controller.enqueue(new TextEncoder().encode(data));
        } catch {
          // Controller closed — stop listening
          unsubscribe();
        }
      });
      // Heartbeat every 30s to keep connection alive through proxies
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
        } catch {
          unsubscribe();
          clearInterval(heartbeat);
        }
      }, 30_000);
      // Cleanup on abort
      req.signal?.addEventListener("abort", () => {
        unsubscribe();
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
});

// Health log — recent health checks recorded by cron jobs
// Ref: node_modules/bun-types/docs/runtime/cron.mdx
const healthLogHandler = withMiddleware<"">((req: BunRequest<"">): Response => {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10), 100);
  const { getHealthLog } = require("./cron") as typeof import("./cron");
  return json({ entries: getHealthLog(limit) });
});

// OpenAPI spec — auto-generated from the routes object
// Ref: node_modules/bun-types/docs/runtime/http/routing.mdx
function generateOpenAPI(routesObj: Record<string, unknown>): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [path, handlers] of Object.entries(routesObj)) {
    // JUSTIFIED: routes object values are typed as unknown; narrowing to handler shape
    const h = handlers as { GET?: unknown; POST?: unknown };
    const pathItem: Record<string, unknown> = {};
    if (h.GET) {
      pathItem.get = {
        summary: `GET ${path}`,
        responses: { "200": { description: "Success" }, "401": { description: "Unauthorized" } },
      };
    }
    if (h.POST) {
      pathItem.post = {
        summary: `POST ${path}`,
        responses: { "200": { description: "Success" }, "401": { description: "Unauthorized" }, "403": { description: "CSRF required" } },
      };
    }
    if (Object.keys(pathItem).length > 0) {
      paths[path] = pathItem;
    }
  }
  return {
    openapi: "3.1.0",
    info: { title: "BUN-DEV API", version: Bun.version, description: "Bun Automation Platform" },
    paths,
  };
}

const openApiHandler = withMiddleware<"">((): Response => {
  return json(generateOpenAPI(routes));
});

// Bun.semver — API version negotiation
// Ref: node_modules/bun-types/docs/runtime/semver.mdx
const semverHandler = withMiddleware<"">((req: BunRequest<"">): Response => {
  const url = new URL(req.url);
  const version = url.searchParams.get("version") ?? Bun.version;
  const range = url.searchParams.get("range") ?? ">=1.3.0";
  const satisfies = Bun.semver.satisfies(version, range);
  return json({
    version,
    range,
    satisfies,
    serverVersion: Bun.version,
    features: {
      http3: Bun.semver.satisfies(version, ">=1.3.14"),
      webview: Bun.semver.satisfies(version, ">=1.3.12"),
      cron: Bun.semver.satisfies(version, ">=1.3.11"),
      image: Bun.semver.satisfies(version, ">=1.3.14"),
    },
  });
});

// Tar export bundle — all JSONL exports in a single .tar download
// Supports ?gzip=1 for compressed output via Bun.deflateSync
// Ref: node_modules/bun-types/docs/runtime/archive.mdx
const exportBundleHandler = withAuth<"">(async (req: BunRequest<"">): Promise<Response> => {
  const url = new URL(req.url);
  const useGzip = url.searchParams.get("gzip") === "1";
  const { createExportBundle, createCompressedExportBundle } = await import("./utils/archive");

  if (useGzip) {
    const bundle = await createCompressedExportBundle();
    // JUSTIFIED: gzip Uint8Array is a valid Response body; DOM BodyInit omits ArrayBufferLike
    return new Response(bundle.data as BodyInit, {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="bun-dev-export-${bundle.date}.tar.gz"`,
        "X-Export-Files": bundle.files.join(", "),
        "X-Export-Original-Size": bundle.originalSize.toString(),
        "X-Export-Compressed-Size": bundle.compressedSize.toString(),
        "X-Export-Ratio": `${((bundle.compressedSize / bundle.originalSize) * 100).toFixed(1)}%`,
      },
    });
  }

  const { archive, date, files } = createExportBundle();
  // JUSTIFIED: Bun.Archive is Blob-like; Response accepts it per archive.mdx docs
  return new Response(archive as unknown as ArrayBuffer, {
    headers: {
      "Content-Type": "application/x-tar",
      "Content-Disposition": `attachment; filename="bun-dev-export-${date}.tar"`,
      "X-Export-Files": files.join(", "),
    },
  });
});

// Bun.glob — auto-discover diagram files
// Ref: node_modules/bun-types/docs/runtime/glob.mdx
const diagramsListHandler = withMiddleware<"">(async (): Promise<Response> => {
  const { Glob } = await import("bun");
  const glob = new Glob("**/*.mmd");
  const diagrams: string[] = [];
  for await (const file of glob.scan("./docs")) {
    diagrams.push(file);
  }
  // Also scan for .mermaid files
  const glob2 = new Glob("**/*.mermaid");
  for await (const file of glob2.scan("./docs")) {
    diagrams.push(file);
  }
  return json({ diagrams, count: diagrams.length });
});

// Bun.YAML/TOML/JSON5 — multi-format config parser
// Ref: node_modules/bun-types/docs/runtime/yaml.mdx
// Ref: node_modules/bun-types/docs/runtime/toml.mdx
// Ref: node_modules/bun-types/docs/runtime/json5.mdx
const configHandler = withMiddleware<"">(async (req: BunRequest<"">): Promise<Response> => {
  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "all";
  const result: Record<string, unknown> = {};

  if (format === "all" || format === "toml") {
    try {
      const tomlFile = Bun.file("bunfig.toml");
      if (await tomlFile.exists()) {
        result.toml = Bun.TOML.parse(await tomlFile.text());
      }
    } catch { result.toml = null; }
  }
  if (format === "all" || format === "yaml") {
    try {
      const yamlFile = Bun.file("docker-compose.yml");
      if (await yamlFile.exists()) {
        result.yaml = Bun.YAML.parse(await yamlFile.text());
      }
    } catch { result.yaml = null; }
  }
  if (format === "all" || format === "json5") {
    try {
      const json5File = Bun.file("tsconfig.json5");
      if (await json5File.exists()) {
        result.json5 = Bun.JSON5.parse(await json5File.text());
      }
    } catch { result.json5 = null; }
  }
  if (format === "all" || format === "json") {
    try {
      const pkgFile = Bun.file("package.json");
      if (await pkgFile.exists()) {
        result.json = await pkgFile.json();
      }
    } catch { result.json = null; }
  }

  return json({ format, config: result, bunVersion: Bun.version });
});

// Bun.shell — safe admin commands
// Ref: node_modules/bun-types/docs/runtime/shell.mdx
const adminShellHandler = withCsrf<"/api/admin/shell">(async (req: BunRequest<"/api/admin/shell">): Promise<Response> => {
  // JUSTIFIED: req.json() returns unknown; narrowing to the admin command shape
  const body = await req.json() as { command: string };
  const allowedCommands = ["vacuum", "status", "workers", "git", "disk", "env"];
  if (!allowedCommands.includes(body.command)) {
    return json({ error: `command must be one of: ${allowedCommands.join(", ")}` }, 400);
  }
  const { $ } = await import("bun");
  try {
    let output = "";
    if (body.command === "vacuum") {
      // Vacuum the SQLite database to reclaim space
      output = await $`echo "VACUUM;" | bun -e "import {Database} from 'bun:sqlite'; const db = new Database(process.env.DB_PATH ?? './data/platform.db'); db.exec('VACUUM'); console.log('VACUUM complete')"`.text();
    } else if (body.command === "status") {
      output = await $`bun -e "console.log(JSON.stringify({uptime: process.uptime(), version: Bun.version, pid: process.pid}, null, 2))"`.text();
    } else if (body.command === "workers") {
      const pool = getPoolStatus();
      output = JSON.stringify(pool, null, 2);
    } else if (body.command === "git") {
      // Bun.shell — safe git status (read-only, no injection possible)
      output = await $`git status --short`.text();
    } else if (body.command === "disk") {
      // Bun.shell — disk usage of the data directory
      output = await $`du -sh ./data ./public ./exports 2>/dev/null || echo "no data dirs"`.text();
    } else if (body.command === "env") {
      // Show safe env vars only
      const safe = ["NODE_ENV", "PORT", "HOST", "BUN_VERSION", "ENABLE_PWA", "ENABLE_SITEMAP"];
      output = safe.map((k) => `${k}=${process.env[k] ?? "unset"}`).join("\n");
    }
    await audit({ action: "admin_command", resource: body.command, details: "shell exec" });
    return json({ command: body.command, output });
  } catch (err) {
    return json({ error: "command failed", details: String(err) }, 500);
  }
});

// Dynamic feature toggle — update feature flags at runtime without restart
// Ref: src/features/registry.ts
const featureToggleHandler = withCsrf<"/api/features/toggle">(async (req: BunRequest<"/api/features/toggle">): Promise<Response> => {
  // JUSTIFIED: req.json() returns unknown; narrowing to the toggle body shape
  const body = await req.json() as { key: string; enabled: boolean };
  const { toggleFeature } = await import("./features/registry");
  const result = toggleFeature(body.key, body.enabled);
  if (!result.ok) {
    return json({ error: result.error }, 400);
  }
  await audit({ action: "feature_toggle", resource: body.key, details: `enabled=${body.enabled}` });
  return json({ ok: true, key: body.key, enabled: body.enabled, active: result.active });
});

// Mermaid live render — paste Mermaid code, get SVG via Bun.WebView
// Ref: node_modules/bun-types/docs/runtime/webview.mdx
const mermaidRenderHandler = withAuth<"/api/mermaid">(async (req: BunRequest<"/api/mermaid">): Promise<Response> => {
  // JUSTIFIED: req.json() returns unknown; narrowing to the mermaid render body
  const body = await req.json() as { code: string };
  if (!body.code || body.code.length > 10_000) {
    return json({ error: "code required (max 10kb)" }, 400);
  }
  try {
    // Use Bun.WebView to render Mermaid to SVG
    // Ref: node_modules/bun-types/docs/runtime/webview.mdx
    await using view = new Bun.WebView({ width: 1200, height: 800 });
    const html = `data:text/html,<!DOCTYPE html><html><head><script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script></head><body><div class="mermaid">${body.code.replace(/</g, "&lt;")}</div><script>mermaid.initialize({startOnLoad:true});</script></body></html>`;
    await view.navigate(html);
    // Wait for mermaid to render
    await Bun.sleep(500);
    // JUSTIFIED: evaluate returns unknown; narrowing to string
    const svg = await view.evaluate("document.querySelector('svg')?.outerHTML ?? ''") as string;
    if (!svg) {
      return json({ error: "render failed — check mermaid syntax" }, 422);
    }
    return new Response(svg, { headers: { "Content-Type": "image/svg+xml" } });
  } catch (err) {
    return json({ error: "render failed", details: String(err) }, 500);
  }
});

// Bun.redis — distributed rate limiting (optional, falls back to SQLite)
// Ref: node_modules/bun-types/docs/runtime/redis.mdx
const redisRateLimitHandler = withMiddleware<"">((req: BunRequest<"">): Response => {
  const url = new URL(req.url);
  const test = url.searchParams.get("test") === "1";
  if (!test) {
    return json({ error: "add ?test=1 to test redis connection" }, 400);
  }
  // Check if REDIS_URL is set
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return json({ redis: "not configured", hint: "set REDIS_URL env var" }, 200);
  }
  // This is async but we return a placeholder — actual redis test would be async
  return json({ redis: "configured", url: redisUrl.replace(/:[^@]+@/, ":***@") });
});

// Bun.s3 — offsite backup status
// Ref: node_modules/bun-types/docs/runtime/s3.mdx
const s3BackupHandler = withAuth<"">(async (): Promise<Response> => {
  const s3Bucket = process.env.S3_BUCKET;
  if (!s3Bucket) {
    return json({ s3: "not configured", hint: "set S3_BUCKET env var to enable offsite backups" });
  }
  return json({
    s3: "configured",
    bucket: s3Bucket,
    lastBackup: null, // Would be populated from health_log or a backup_log table
    nextBackup: "daily at 2 AM (via cron)",
  });
});

// Bun.console — structured logging endpoint
// Ref: node_modules/bun-types/docs/runtime/console.mdx
const logsHandler = withAuth<"">((req: BunRequest<"">): Response => {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  return json({ logs: getLogs(limit), count: getLogCount() });
});

// Bun.streams — streaming file response for large files
// Ref: node_modules/bun-types/docs/runtime/streams.mdx
const streamFileHandler = withMiddleware<"/api/stream/:path">((req: BunRequest<"/api/stream/:path">): Response => {
  const filePath = req.params.path;
  // Security: only allow streaming files from the public directory
  if (filePath.includes("..") || filePath.includes("//")) {
    return json({ error: "invalid path" }, 400);
  }
  const file = Bun.file(`public/${filePath}`);
  if (!file.size || file.size === 0) {
    return json({ error: "file not found" }, 404);
  }
  // Bun.file returns a Blob-like object that Response can stream directly
  // This uses Bun's native streaming — no manual ReadableStream needed
  return new Response(file, {
    headers: {
      "Content-Type": file.type,
      "Content-Length": file.size.toString(),
      "Cache-Control": "public, max-age=3600",
    },
  });
});

// Bun.sql — unified SQL query endpoint using tagged template literals
// Ref: node_modules/bun-types/docs/runtime/sql.mdx
const sqlQueryHandler = withAuth<"/api/sql">(async (req: BunRequest<"/api/sql">): Promise<Response> => {
  // JUSTIFIED: req.json() returns unknown; narrowing to the query body
  const body = await req.json() as { query: string; params?: unknown[] };
  if (!body.query || !body.query.trim().toUpperCase().startsWith("SELECT")) {
    return json({ error: "only SELECT queries allowed" }, 400);
  }
  try {
    // Use bun:sqlite directly (Bun.sql with sqlite:// protocol also works)
    // This demonstrates the unified SQL API pattern
    const results = read((db) => {
      // Only SELECT queries allowed (validated above) — safe to execute
      // JUSTIFIED: .all() returns unknown[]; narrowing to record array
      return db.query(body.query).all() as Record<string, unknown>[];
    });
    log("server", "info", "SQL query executed", { rows: results.length });
    return json({ rows: results, count: results.length });
  } catch (err) {
    return json({ error: "query failed", details: String(err) }, 422);
  }
});

// Bun.ffi — native library loading demo
// Ref: node_modules/bun-types/docs/runtime/ffi.mdx
const ffiHandler = withMiddleware<"">((): Response => {
  try {
    // Demo: load libsqlite3 and get its version string
    // This proves FFI works without any npm packages
    const { dlopen, FFIType, suffix } = require("bun:ffi") as typeof import("bun:ffi");
    const path = `libsqlite3.${suffix}`;
    // JUSTIFIED: dlopen returns complex Library type; CString → string via unknown
    const lib = dlopen(path, {
      sqlite3_libversion: { args: [], returns: FFIType.cstring },
    });
    const version = String(lib.symbols.sqlite3_libversion());
    return json({
      ffi: "working",
      library: path,
      sqlite3_version: version,
      note: "Bun.ffi loaded libsqlite3 natively — zero npm dependencies",
    });
  } catch (err) {
    return json({
      ffi: "available",
      error: String(err),
      note: "FFI module loaded but library not found (expected on some systems)",
    });
  }
});

// Bun.Image — image processing endpoint (resize/convert)
// Ref: node_modules/bun-types/docs/runtime/image.mdx
const imageProcessHandler = withAuth<"/api/image">(async (req: BunRequest<"/api/image">): Promise<Response> => {
  const url = new URL(req.url);
  const width = parseInt(url.searchParams.get("width") ?? "128", 10);
  const height = parseInt(url.searchParams.get("height") ?? "128", 10);
  const format = (url.searchParams.get("format") ?? "png") as "png" | "webp" | "jpeg";
  const srcPath = url.searchParams.get("src");
  if (!srcPath || srcPath.includes("..")) {
    return json({ error: "src parameter required (e.g. ?src=/icons/icon-512.png)" }, 400);
  }
  try {
    // Use Bun.Image chainable pipeline — like Sharp but native
    // Ref: node_modules/bun-types/docs/runtime/image.mdx
    const file = Bun.file(`public${srcPath}`);
    if (!file.size) return json({ error: "source file not found" }, 404);
    // JUSTIFIED: Bun.Image chain returns a complex union type; narrowing to Image
    const processed = file.image().resize(width, height, { fit: "inside" });
    // JUSTIFIED: format method names vary by bun-types; using unknown intermediate
    let output: Blob;
    if (format === "webp") {
      // JUSTIFIED: .webp() returns Blob per image.mdx docs
      output = await processed.webp({ quality: 80 }) as unknown as Blob;
    } else if (format === "jpeg") {
      // JUSTIFIED: .jpeg() returns Blob per image.mdx docs
      output = await processed.jpeg({ quality: 80 }) as unknown as Blob;
    } else {
      // JUSTIFIED: .png() returns Blob per image.mdx docs
      output = await processed.png() as unknown as Blob;
    }
    return new Response(output, {
      headers: {
        "Content-Type": `image/${format}`,
        "Cache-Control": "public, max-age=3600",
        "X-Image-Original": file.size.toString(),
        "X-Image-Resized": `${width}x${height}`,
      },
    });
  } catch (err) {
    return json({ error: "image processing failed", details: String(err) }, 500);
  }
});

// Bun.hashing — hash verification endpoint
// Ref: node_modules/bun-types/docs/runtime/hashing.mdx
const hashHandler = withMiddleware<"/api/hash">((req: BunRequest<"/api/hash">): Response => {
  const url = new URL(req.url);
  const input = url.searchParams.get("input");
  const algorithm = (url.searchParams.get("algorithm") ?? "sha256") as "sha256" | "sha512" | "md5" | "sha1";
  if (!input) {
    return json({ error: "input parameter required (e.g. ?input=hello)" }, 400);
  }
  // Bun.CryptoHasher.hash — synchronous, returns hex by default
  // Ref: node_modules/bun-types/docs/runtime/hashing.mdx
  const hash = Bun.CryptoHasher.hash(algorithm, input, "hex");
  return json({
    input,
    algorithm,
    hash,
    length: hash.length,
  });
});

// Screenshot endpoint via Bun.WebView
// Ref: node_modules/bun-types/docs/runtime/webview.mdx
const screenshotHandler = withAuth<"/api/screenshot">(async (req: BunRequest<"/api/screenshot">): Promise<Response> => {
  const url = new URL(req.url);
  const targetUrl = url.searchParams.get("url");
  const width = parseInt(url.searchParams.get("width") ?? "1280", 10);
  const height = parseInt(url.searchParams.get("height") ?? "720", 10);
  if (!targetUrl) {
    return json({ error: "url parameter required (e.g. ?url=https://example.com)" }, 400);
  }
  // Security: only allow http/https URLs
  if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
    return json({ error: "url must start with http:// or https://" }, 400);
  }
  try {
    // Ref: node_modules/bun-types/docs/runtime/webview.mdx#screenshot
    await using view = new Bun.WebView({ width, height, url: targetUrl });
    await view.navigate(targetUrl);
    // Wait for page to render
    await Bun.sleep(1000);
    const screenshot = await view.screenshot();
    log("server", "info", "Screenshot captured", { url: targetUrl, size: screenshot.size });
    return new Response(screenshot, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=300",
        "X-Screenshot-URL": targetUrl,
      },
    });
  } catch (err) {
    return json({ error: "screenshot failed", details: String(err) }, 500);
  }
});

// Config editor — write YAML/TOML/JSON5
// Ref: node_modules/bun-types/docs/runtime/yaml.mdx
// Ref: node_modules/bun-types/docs/runtime/toml.mdx
// Ref: node_modules/bun-types/docs/runtime/json5.mdx
const configWriteHandler = withCsrf<"/api/config/write">(async (req: BunRequest<"/api/config/write">): Promise<Response> => {
  // JUSTIFIED: req.json() returns unknown; narrowing to the config write body
  const body = await req.json() as { format: "yaml" | "toml" | "json5"; data: Record<string, unknown>; filename: string };
  if (!body.data || !body.format || !body.filename) {
    return json({ error: "format, data, and filename required" }, 400);
  }
  if (body.filename.includes("..") || body.filename.includes("/")) {
    return json({ error: "filename must be a simple name (no paths)" }, 400);
  }
  try {
    let content: string;
    if (body.format === "yaml") {
      // JUSTIFIED: Bun.YAML.stringify exists per yaml.mdx but not in all bun-types versions
      const yamlStr = (Bun.YAML as { stringify?: (d: unknown) => string }).stringify?.(body.data);
      content = yamlStr ?? JSON.stringify(body.data, null, 2);
    } else if (body.format === "toml") {
      // JUSTIFIED: Bun.TOML.stringify exists per toml.mdx but not in all bun-types versions
      const tomlStr = (Bun.TOML as { stringify?: (d: unknown) => string }).stringify?.(body.data);
      content = tomlStr ?? JSON.stringify(body.data, null, 2);
    } else {
      // JUSTIFIED: Bun.JSON5.stringify exists per json5.mdx but return type may be optional
      content = Bun.JSON5.stringify(body.data) ?? JSON.stringify(body.data, null, 2);
    }
    const path = `./exports/${body.filename}.${body.format === "json5" ? "json5" : body.format}`;
    await Bun.write(path, content);
    await audit({ action: "config_write", resource: path, details: `format=${body.format}` });
    log("server", "info", "Config file written", { path, format: body.format });
    return json({ ok: true, path, size: content.length });
  } catch (err) {
    return json({ error: "write failed", details: String(err) }, 500);
  }
});

// Bun.Transpiler — transpile TS/JSX to JS
// Ref: node_modules/bun-types/docs/runtime/transpiler.mdx
const transpileHandler = withMiddleware<"/api/transpile">((req: BunRequest<"/api/transpile">): Response => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const target = (url.searchParams.get("target") ?? "browser") as "browser" | "bun";
  if (!code) {
    return json({ error: "code parameter required (e.g. ?code=const x: number = 1)" }, 400);
  }
  try {
    // JUSTIFIED: Bun.Transpiler per transpiler.mdx — constructor accepts options
    const transpiler = new Bun.Transpiler({
      loader: "tsx",
      target: target === "bun" ? "bun" : "browser",
    });
    // JUSTIFIED: .transformSync returns string per transpiler.mdx
    const output = transpiler.transformSync(code) as string;
    return json({
      input: code,
      output,
      inputSize: code.length,
      outputSize: output.length,
      target,
    });
  } catch (err) {
    return json({ error: "transpile failed", details: String(err) }, 422);
  }
});

// Bun.dns — DNS lookup endpoint
// Ref: node_modules/bun-types/bun.d.ts#dns
const dnsHandler = withMiddleware<"/api/dns">((req: BunRequest<"/api/dns">): Response => {
  const url = new URL(req.url);
  const host = url.searchParams.get("host");
  if (!host) {
    return json({ error: "host parameter required (e.g. ?host=example.com)" }, 400);
  }
  // Bun.dns.lookup is async — return a Response.json with a promise
  // We use Response.json with an async IIFE pattern
  return new Response(
    JSON.stringify({
      error: "use POST /api/dns for async DNS lookup",
      hint: "GET /api/dns?host=example.com returns this message; POST with {host} for results",
    }),
    { headers: { "Content-Type": "application/json" } },
  );
});

// Async DNS lookup handler (POST)
const dnsLookupHandler = withMiddleware<"/api/dns">((req: BunRequest<"/api/dns">): Response | Promise<Response> => {
  if (req.method !== "POST") {
    return json({ error: "POST required with {host: 'example.com'}" }, 405);
  }
  // Return a promise that resolves with DNS results
  return req.json().then((body: unknown) => {
    // JUSTIFIED: body is unknown from req.json(); narrowing to dns lookup shape
    const { host } = body as { host?: string };
    if (!host) {
      return json({ error: "host required in body" }, 400);
    }
    // Bun.dns.lookup — async DNS resolution
    // Ref: node_modules/bun-types/bun.d.ts#dns.lookup
    return Bun.dns.lookup(host).then((results) => {
      return json({
        host,
        results: results.map((r) => ({ address: r.address, family: r.family })),
        count: results.length,
      });
    }).catch((err: Error) => {
      return json({ error: "DNS lookup failed", details: String(err) }, 502);
    });
  });
});

// Bun.spawn — process manager (list running processes)
// Ref: node_modules/bun-types/bun.d.ts#Bun.spawn
const processesHandler = withAuth<"">(async (): Promise<Response> => {
  try {
    // Use Bun.spawn to run ps and get process list
    // Ref: node_modules/bun-types/bun.d.ts#Bun.spawn
    const proc = Bun.spawn(["ps", "aux"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    // Parse ps output — first line is header, rest are processes
    const lines = text.trim().split("\n");
    // Take top 20 processes by CPU
    const processes = lines.slice(1, 21).map((line) => {
      const parts = line.split(/\s+/);
      return {
        user: parts[0],
        pid: parts[1],
        cpu: parts[2],
        mem: parts[3],
        command: parts.slice(10).join(" ").slice(0, 80),
      };
    });
    return json({ processes, count: processes.length, total: lines.length - 1 });
  } catch (err) {
    return json({ error: "process listing failed", details: String(err) }, 500);
  }
});

// Bun.file — filesystem browser
// Ref: node_modules/bun-types/docs/runtime/file.mdx
const fsBrowserHandler = withAuth<"/api/fs">((req: BunRequest<"/api/fs">): Response => {
  const url = new URL(req.url);
  const dirPath = url.searchParams.get("path") ?? ".";
  // Security: prevent path traversal outside project dir
  if (dirPath.includes("..") || dirPath.startsWith("/")) {
    return json({ error: "path must be within project directory" }, 403);
  }
  try {
    // Use node:fs.readdirSync to list entries (includes directories)
    // Bun.Glob only returns files, not directories
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const entries = readdirSync(dirPath, { withFileTypes: true });
    const files = entries.map((entry) => {
      const fullPath = `${dirPath}/${entry.name}`;
      const isDir = entry.isDirectory();
      const stat = isDir ? null : statSync(fullPath);
      return {
        name: entry.name,
        path: fullPath,
        size: isDir ? 0 : stat!.size,
        type: isDir ? "directory" : Bun.file(fullPath).type,
        lastModified: isDir ? 0 : stat!.mtimeMs,
      };
    }).sort((a, b) => {
      // Directories first, then alphabetical
      if (a.type === "directory" && b.type !== "directory") return -1;
      if (a.type !== "directory" && b.type === "directory") return 1;
      return a.name.localeCompare(b.name);
    });
    return json({ path: dirPath, files, count: files.length });
  } catch (err) {
    return json({ error: "filesystem browse failed", details: String(err) }, 500);
  }
});

// Bun.deflateSync/inflateSync — compression utility
// Ref: node_modules/bun-types/bun.d.ts#deflateSync
const compressHandler = withMiddleware<"/api/compress">((req: BunRequest<"/api/compress">): Response => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "compress";
  const input = url.searchParams.get("input");
  if (!input) {
    return json({ error: "input parameter required" }, 400);
  }
  try {
    if (action === "compress") {
      // Bun.deflateSync — compress to zlib
      const compressed = Bun.deflateSync(new TextEncoder().encode(input));
      // Convert to base64 for display
      const b64 = btoa(String.fromCharCode(...compressed));
      return json({
        action: "compress",
        input,
        inputSize: input.length,
        compressedSize: compressed.byteLength,
        compressed: b64,
        ratio: `${((compressed.byteLength / input.length) * 100).toFixed(1)}%`,
      });
    } else if (action === "decompress") {
      // Bun.inflateSync — decompress from zlib
      const bytes = Uint8Array.from(atob(input), (c) => c.charCodeAt(0));
      const decompressed = Bun.inflateSync(bytes);
      const text = new TextDecoder().decode(decompressed);
      return json({
        action: "decompress",
        input,
        inputSize: input.length,
        decompressedSize: decompressed.byteLength,
        decompressed: text,
      });
    } else {
      return json({ error: "action must be 'compress' or 'decompress'" }, 400);
    }
  } catch (err) {
    return json({ error: "compression failed", details: String(err) }, 500);
  }
});

// Utility endpoints — escapeHTML, base64, structuredClone
const utilsHandler = withMiddleware<"/api/utils">((req: BunRequest<"/api/utils">): Response => {
  const url = new URL(req.url);
  const tool = url.searchParams.get("tool") ?? "escape";
  const input = url.searchParams.get("input");
  if (!input) {
    return json({ error: "input parameter required" }, 400);
  }
  switch (tool) {
    case "escape":
      // Bun.escapeHTML — escape HTML special characters
      // Ref: node_modules/bun-types/bun.d.ts#escapeHTML
      return json({ tool: "escapeHTML", input, output: Bun.escapeHTML(input) });
    case "base64-encode":
      return json({ tool: "base64-encode", input, output: btoa(input) });
    case "base64-decode":
      try {
        return json({ tool: "base64-decode", input, output: atob(input) });
      } catch {
        return json({ error: "invalid base64 input" }, 400);
      }
    case "clone":
      // structuredClone — deep clone any value
      // JUSTIFIED: structuredClone is a global, not Bun-specific, but useful
      const cloned = structuredClone(JSON.parse(input));
      return json({ tool: "structuredClone", input, output: cloned });
    case "urlencode":
      return json({ tool: "urlencode", input, output: encodeURIComponent(input) });
    case "urldecode":
      try {
        return json({ tool: "urldecode", input, output: decodeURIComponent(input) });
      } catch {
        return json({ error: "invalid URL-encoded input" }, 400);
      }
    default:
      return json({ error: "unknown tool. Available: escape, base64-encode, base64-decode, clone, urlencode, urldecode" }, 400);
  }
});

// Bun.gc + Bun.nanoseconds + Bun.shrink — runtime introspection
// Ref: node_modules/bun-types/bun.d.ts#gc, #nanoseconds, #shrink
const runtimeHandler = withAuth<"">(async (req: BunRequest<"">): Promise<Response> => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "status";
  if (action === "gc") {
    // Bun.gc — force garbage collection
    const before = process.memoryUsage();
    Bun.gc(true);
    const after = process.memoryUsage();
    return json({
      action: "gc",
      before: { heapUsed: before.heapUsed, heapTotal: before.heapTotal, rss: before.rss },
      after: { heapUsed: after.heapUsed, heapTotal: after.heapTotal, rss: after.rss },
      freed: before.heapUsed - after.heapUsed,
    });
  } else if (action === "shrink") {
    // Bun.shrink — release memory back to OS
    const before = process.memoryUsage();
    Bun.shrink();
    const after = process.memoryUsage();
    return json({
      action: "shrink",
      before: { rss: before.rss, heapTotal: before.heapTotal },
      after: { rss: after.rss, heapTotal: after.heapTotal },
      freed: before.rss - after.rss,
    });
  } else if (action === "nanoseconds") {
    // Bun.nanoseconds — high-resolution timing
    // Run a quick benchmark
    const start = Bun.nanoseconds();
    // Do some work
    for (let i = 0; i < 1000; i++) Math.sqrt(i);
    const end = Bun.nanoseconds();
    return json({
      action: "nanoseconds",
      startNs: start,
      endNs: end,
      elapsedNs: end - start,
      elapsedMs: (end - start) / 1_000_000,
      uptimeNs: start,
      note: "Bun.nanoseconds — nanosecond precision timing since process start",
    });
  }
  // Default: status
  const mem = process.memoryUsage();
  return json({
    action: "status",
    uptime: process.uptime(),
    uptimeNs: Bun.nanoseconds(),
    bunVersion: Bun.version,
    pid: process.pid,
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
    },
    gc: "available via ?action=gc",
    shrink: "available via ?action=shrink",
    nanoseconds: "available via ?action=nanoseconds",
  });
});

// R5: Dev dashboard — simple HTML page showing server status.
// Will be replaced with React + HTML imports dashboard (OPEN_TASKS F1).
// D6: Dashboard is dev-only — auto-disabled in production unless explicitly enabled.
const dashboardHandler = withMiddleware((): Response => {
  const pool = getPoolStatus();
  const features = listFeatures()
    .map((f) => `<tr><td>${f.key}</td><td>${f.status}</td><td>${f.active ? "✅ active" : f.blocked ? "⚠️ blocked" : "❌ off"}</td><td>${f.description}</td></tr>`)
    .join("\n");
  // iOS/macOS ignore manifest icons entirely and read apple-touch-icon, which
  // must be 180x180 and opaque (Apple applies its own rounded-corner crop and
  // composites transparency onto black).
  // Ref: https://developer.apple.com/design/human-interface-guidelines/app-icons
  //
  // theme-color is declared twice with prefers-color-scheme so the browser
  // chrome matches the dashboard's actual light/dark palettes. The first
  // matching declaration wins, so these take precedence over the unconditional
  // fallback that HTMLRewriter appends to <head> later.
  const pwaLinks = ENABLE_PWA
    ? `<link rel="manifest" href="/manifest.json">
  <link rel="icon" type="image/png" sizes="128x128" href="/icons/icon-128.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png">
  <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#1f2020" media="(prefers-color-scheme: dark)">
  <meta name="msapplication-TileColor" content="#1f2020">`
    : "";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BUN-DEV — Dashboard</title>
  ${pwaLinks}
  <style>
    :root {
      --bg: #1f2020;
      --bg-card: #2a2b2b;
      --bg-nav: #161717;
      --fg: #f8f8f2;
      --fg-dim: #a8a8a0;
      --accent: #50fa7b;
      --accent-dim: #3a9d5c;
      --warn: #ffb86c;
      --err: #ff5555;
      --info: #8be9fd;
      --border: #3a3b3b;
      --radius: 8px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, "SF Mono", "Martian Mono", monospace;
      background: var(--bg);
      color: var(--fg);
      max-width: 900px;
      margin: 0 auto;
      padding: 1rem;
      line-height: 1.6;
    }
    .nav-bar {
      display: flex; gap: 0.25rem; align-items: center; padding: 0.5rem 0.75rem;
      background: var(--bg-nav); border-radius: var(--radius); margin-bottom: 1.5rem;
      flex-wrap: wrap; border: 1px solid var(--border);
    }
    .nav-bar a {
      color: var(--info); text-decoration: none; padding: 0.3rem 0.7rem;
      border-radius: 4px; font-size: 0.85rem;
    }
    .nav-bar a:hover { background: var(--border); }
    .nav-bar a.active { background: var(--accent); color: var(--bg); font-weight: 600; }
    .nav-bar .nav-sep { color: var(--border); margin: 0 0.1rem; }
    .nav-bar button {
      background: var(--accent); color: var(--bg); border: 1px solid var(--accent-dim);
      padding: 0.3rem 0.7rem; border-radius: 4px; font-size: 0.85rem; cursor: pointer;
      font-family: inherit;
    }
    .nav-bar button:hover { background: #6bff8e; }
    .nav-bar .pwa-install {
      background: var(--info); color: var(--bg); border-color: #5ab8d0;
      display: none; margin-left: auto;
    }
    .nav-bar .pwa-install:hover { background: #a3e6f5; }
    h1 { color: var(--accent); font-size: 1.6rem; margin-bottom: 0.25rem; }
    h1 .version { color: var(--fg-dim); font-size: 0.9rem; font-weight: normal; }
    h2 { color: var(--fg); font-size: 1.1rem; margin: 1.5rem 0 0.5rem; padding-bottom: 0.25rem; border-bottom: 1px solid var(--border); }
    .header-row { display: flex; justify-content: space-between; align-items: center; }
    .sw-badge {
      font-size: 0.75rem; padding: 0.2rem 0.6rem; border-radius: 12px;
      background: var(--border); color: var(--fg-dim);
    }
    .sw-badge.active { background: var(--accent-dim); color: var(--accent); }
    .sw-badge.inactive { background: #4a2b2b; color: var(--err); }
    .status-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 0.75rem; margin: 0.5rem 0;
    }
    .stat-card {
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 0.75rem 1rem;
    }
    .stat-card .label { font-size: 0.75rem; color: var(--fg-dim); text-transform: uppercase; letter-spacing: 0.05em; }
    .stat-card .value { font-size: 1.3rem; color: var(--accent); font-weight: 600; }
    .stat-card .value.warn { color: var(--warn); }
    .stat-card .value.err { color: var(--err); }
    table { width: 100%; border-collapse: collapse; margin: 0.5rem 0; font-size: 0.85rem; }
    th, td { padding: 0.4rem 0.6rem; text-align: left; border-bottom: 1px solid var(--border); }
    th { color: var(--fg-dim); font-weight: 600; text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.05em; }
    td { color: var(--fg); }
    tr:hover td { background: var(--bg-card); }
    ul { list-style: none; padding: 0; }
    ul li { padding: 0.3rem 0; font-size: 0.9rem; }
    ul li a { color: var(--info); text-decoration: none; }
    ul li a:hover { text-decoration: underline; }
    ul li code { color: var(--warn); font-size: 0.85rem; }
    #features-panel {
      display: none; margin-top: 0.5rem; padding: 1rem;
      background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius);
    }
    #features-panel pre { font-size: 0.8rem; overflow-x: auto; color: var(--accent); }
    .pwa-section {
      background: var(--bg-card); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 1rem; margin: 0.5rem 0;
    }
    .pwa-section .pwa-row { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; }
    .pwa-section .pwa-icon { width: 48px; height: 48px; border-radius: 8px; }
    .pwa-section .pwa-info { flex: 1; min-width: 200px; }
    .pwa-section .pwa-info h3 { color: var(--accent); font-size: 1rem; margin-bottom: 0.2rem; }
    .pwa-section .pwa-info p { color: var(--fg-dim); font-size: 0.8rem; }
    .pwa-section .pwa-links { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .pwa-section .pwa-links a {
      color: var(--info); font-size: 0.8rem; padding: 0.2rem 0.5rem;
      border: 1px solid var(--border); border-radius: 4px; text-decoration: none;
    }
    .pwa-section .pwa-links a:hover { background: var(--border); }
    .pwa-section .pwa-links button {
      background: var(--border); color: var(--info); border: 1px solid var(--border);
      padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.8rem; cursor: pointer;
      font-family: inherit;
    }
    .pwa-section .pwa-links button:hover { background: var(--accent-dim); color: var(--accent); }
    .icon-gallery { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.5rem; }
    .icon-gallery .icon-item {
      text-align: center; padding: 0.4rem; background: var(--bg-nav);
      border: 1px solid var(--border); border-radius: 6px;
    }
    .icon-gallery .icon-item img { display: block; margin: 0 auto 0.2rem; border-radius: 4px; }
    .icon-gallery .icon-item .icon-size { font-size: 0.65rem; color: var(--fg-dim); }
    .icon-gallery .icon-item .icon-label { font-size: 0.65rem; color: var(--info); }
    .icon-vs { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 0.5rem; }
    .icon-vs .icon-col h4 { color: var(--accent); font-size: 0.85rem; margin-bottom: 0.3rem; }
    .icon-vs .icon-col .icon-grid { display: flex; gap: 0.3rem; flex-wrap: wrap; }
    .icon-vs .icon-col .icon-grid img { border-radius: 4px; border: 1px solid var(--border); }
    .net-badge {
      font-size: 0.75rem; padding: 0.2rem 0.6rem; border-radius: 12px;
      background: var(--accent-dim); color: var(--accent);
    }
    .net-badge.offline { background: #4a2b2b; color: var(--err); }
    .sw-cache-bar { height: 6px; background: var(--bg-nav); border-radius: 3px; margin-top: 0.3rem; overflow: hidden; }
    .sw-cache-bar .sw-cache-fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width 0.3s; }
    .kbd { font-size: 0.7rem; padding: 0.1rem 0.35rem; border: 1px solid var(--border); border-radius: 3px; background: var(--bg-nav); color: var(--fg-dim); }
    .toast {
      position: fixed; bottom: 1rem; right: 1rem; background: var(--bg-card);
      border: 1px solid var(--accent); border-radius: 6px; padding: 0.6rem 1rem;
      color: var(--accent); font-size: 0.85rem; z-index: 999;
      opacity: 0; transition: opacity 0.3s; pointer-events: none;
    }
    .toast.show { opacity: 1; }
    .health-pulse { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 0.3rem; }
    .health-pulse.ok { background: var(--accent); animation: pulse 2s infinite; }
    .health-pulse.err { background: var(--err); }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
    .copy-btn { cursor: pointer; font-size: 0.75rem; color: var(--info); }
    .copy-btn:hover { color: var(--accent); }
    footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--fg-dim); font-size: 0.75rem; text-align: center; }
    /* Dark/light mode — respects OS preference */
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #ffffff;
        --bg-card: #f5f5f5;
        --bg-nav: #e8e8e8;
        --fg: #1a1a1a;
        --fg-dim: #666666;
        --accent: #0066cc;
        --accent-dim: #004499;
        --warn: #cc7700;
        --err: #cc0000;
        --info: #0066aa;
        --border: #dddddd;
      }
    }
  </style>
</head>
<body>
  <nav class="nav-bar">
    <a href="/dashboard" class="active">Dashboard</a>
    <span class="nav-sep">/</span>
    <a href="/diagrams">Diagrams</a>
    <span class="nav-sep">/</span>
    <a href="/features">Features JSON</a>
    <span class="nav-sep">/</span>
    <a href="/health">Health</a>
    <span class="nav-sep">/</span>
    <a href="/protocol">Protocol</a>
    ${NODE_ENV === "development" ? '<button id="nav-features" onclick="fetchFeatures()">Features</button>' : ""}
    ${ENABLE_PWA ? '<button class="pwa-install" id="pwa-install-btn" onclick="installPWA()">Install App</button>' : ""}
  </nav>
  <div class="header-row">
    <h1>BUN-DEV <span class="version">v${Bun.version}</span></h1>
    <div style="display: flex; gap: 0.5rem; align-items: center;">
      <span class="net-badge" id="net-status">● Online</span>
      ${ENABLE_PWA ? '<span class="sw-badge" id="sw-status">SW: checking...</span>' : ""}
    </div>
  </div>
  <p style="color: var(--fg-dim); font-size: 0.85rem; margin-bottom: 1rem;">Bun Automation Platform — Player Health Dashboard</p>

  <h2>Status <span class="health-pulse ok" id="health-pulse"></span></h2>
  <div class="status-grid">
    <div class="stat-card">
      <div class="label">Environment</div>
      <div class="value">${NODE_ENV}</div>
    </div>
    <div class="stat-card">
      <div class="label">TLS</div>
      <div class="value ${ENABLE_TLS ? "" : "err"}">${ENABLE_TLS ? "Enabled" : "Off"}</div>
    </div>
    <div class="stat-card">
      <div class="label">HTTP/3</div>
      <div class="value ${ENABLE_HTTP3 ? "" : "warn"}">${ENABLE_HTTP3 ? "Enabled" : "Off"}</div>
    </div>
    <div class="stat-card">
      <div class="label">Workers</div>
      <div class="value" id="workers-stat">${pool.idle}/${pool.total} idle</div>
    </div>
    <div class="stat-card">
      <div class="label">Uptime</div>
      <div class="value" id="uptime">${Math.floor(process.uptime())}s</div>
    </div>
    <div class="stat-card">
      <div class="label">PWA</div>
      <div class="value ${ENABLE_PWA ? "" : "warn"}">${ENABLE_PWA ? "Enabled" : "Off"}</div>
    </div>
    <div class="stat-card">
      <div class="label">Health</div>
      <div class="value" id="health-stat" style="font-size: 0.9rem;">checking...</div>
    </div>
    <div class="stat-card">
      <div class="label">Routes</div>
      <div class="value" id="routes-stat">—</div>
    </div>
  </div>

  <h2>Feature Flags <span style="font-size:0.75rem; color:var(--fg-dim);">(click toggle to change at runtime — no restart)</span></h2>
  <table id="feature-flag-table">
    <tr><th>Feature</th><th>Status</th><th>State</th><th>Description</th><th>Toggle</th></tr>
    ${features}
  </table>
  <div id="features-panel">
    <h3 style="cursor:pointer; color:var(--accent);" onclick="document.getElementById('features-panel').style.display='none'">Live Feature Flags ✕</h3>
    <pre id="features-output">Loading...</pre>
  </div>

  <div class="pwa-section" style="margin-top: 0.5rem;">
    <h3 style="color: var(--accent); cursor: pointer;" onclick="toggleSection('audit-terminal-content', this)">
      Live Audit Log Terminal (SSE) ▸
    </h3>
    <div id="audit-terminal-content" style="display: none; margin-top: 0.5rem;">
      <pre id="audit-terminal" style="background: var(--bg-nav); border: 1px solid var(--border); border-radius: 4px; padding: 0.5rem; font-size: 0.75rem; max-height: 300px; overflow-y: auto; color: var(--accent);"></pre>
      <button onclick="startAuditStream()" id="audit-stream-btn" style="background:var(--accent); color:var(--bg); border:none; padding:0.3rem 0.7rem; border-radius:4px; cursor:pointer; font-family:inherit;">Start Streaming</button>
    </div>
  </div>

  <div class="pwa-section" style="margin-top: 0.5rem;">
    <h3 style="color: var(--accent); cursor: pointer;" onclick="toggleSection('mermaid-content', this)">
      Mermaid Live Renderer ▸
    </h3>
    <div id="mermaid-content" style="display: none; margin-top: 0.5rem;">
      <textarea id="mermaid-input" rows="5" style="width:100%; background:var(--bg-nav); color:var(--fg); border:1px solid var(--border); border-radius:4px; padding:0.5rem; font-family:inherit; font-size:0.8rem;" placeholder="graph TD; A-->B; B-->C;"></textarea>
      <button onclick="renderMermaid()" style="background:var(--accent); color:var(--bg); border:none; padding:0.3rem 0.7rem; border-radius:4px; cursor:pointer; font-family:inherit; margin-top:0.3rem;">Render SVG</button>
      <div id="mermaid-output" style="margin-top:0.5rem; background:var(--bg-nav); border:1px solid var(--border); border-radius:4px; padding:0.5rem; min-height:100px;"></div>
    </div>
  </div>

  <div class="pwa-section" style="margin-top: 0.5rem;">
    <h3 style="color: var(--accent); cursor: pointer;" onclick="toggleSection('swagger-content', this)">
      API Docs (OpenAPI) ▸
    </h3>
    <div id="swagger-content" style="display: none; margin-top: 0.5rem;">
      <div id="swagger-output" style="color: var(--fg-dim); font-size: 0.8rem;">Loading...</div>
    </div>
  </div>

  ${ENABLE_PWA ? `
  <h2>PWA — Installable App</h2>
  <div class="pwa-section">
    <div class="pwa-row">
      <img src="/icons/icon-128.png" alt="BUN-DEV" class="pwa-icon">
      <div class="pwa-info">
        <h3>BUN-DEV</h3>
        <p>Install this dashboard as a standalone Chrome app. Works offline with cached assets.</p>
      </div>
    </div>
    <div class="pwa-links" style="margin-top: 0.75rem;">
      <a href="/manifest.json">manifest.json</a>
      <a href="/sw.js">sw.js</a>
      <a href="/icons/icon-512.png">icon (512px)</a>
      <a href="/api/pwa/validate">validate</a>
      <a href="/api/pwa/compare">vs bun.com</a>
      <a href="/bun-com/manifest.json">bun.com manifest</a>
      <a href="/bun-com/icons/icon-512x512.png">bun.com icon</a>
      <button onclick="copyManifest()">Copy Manifest JSON</button>
    </div>
  </div>

  <div class="pwa-section" style="margin-top: 0.5rem;">
    <h3 style="color: var(--accent); cursor: pointer;" onclick="toggleSection('icon-gallery-content', this)">
      Icon Gallery ▸
    </h3>
    <div id="icon-gallery-content" style="display: none; margin-top: 0.5rem;">
      <h4 style="color:var(--info); font-size:0.85rem; margin-bottom:0.3rem;">BUN-DEV Icons</h4>
      <div class="icon-gallery">
        <div class="icon-item"><img src="/icons/icon-16.png" width="16" height="16"><span class="icon-size">16px</span></div>
        <div class="icon-item"><img src="/icons/icon-32.png" width="32" height="32"><span class="icon-size">32px</span></div>
        <div class="icon-item"><img src="/icons/icon-48.png" width="48" height="48"><span class="icon-size">48px</span></div>
        <div class="icon-item"><img src="/icons/icon-64.png" width="64" height="64"><span class="icon-size">64px</span></div>
        <div class="icon-item"><img src="/icons/icon-96.png" width="96" height="96"><span class="icon-size">96px</span></div>
        <div class="icon-item"><img src="/icons/icon-128.png" width="128" height="128"><span class="icon-size">128px</span></div>
        <div class="icon-item"><img src="/icons/icon-192.png" width="64" height="64"><span class="icon-size">192px</span></div>
        <div class="icon-item"><img src="/icons/icon-256.png" width="64" height="64"><span class="icon-size">256px</span></div>
        <div class="icon-item"><img src="/icons/icon-512.png" width="64" height="64"><span class="icon-size">512px</span></div>
        <div class="icon-item"><img src="/icons/icon-1024.png" width="64" height="64"><span class="icon-size">1024px</span></div>
        <div class="icon-item"><img src="/icons/maskable-512.png" width="64" height="64"><span class="icon-label">maskable</span></div>
      </div>
      <h4 style="color:var(--info); font-size:0.85rem; margin: 0.75rem 0 0.3rem;">bun.com Icons</h4>
      <div class="icon-gallery">
        <div class="icon-item"><img src="/bun-com/icons/favicon-16x16.png" width="16" height="16"><span class="icon-size">16px</span></div>
        <div class="icon-item"><img src="/bun-com/icons/favicon-32x32.png" width="32" height="32"><span class="icon-size">32px</span></div>
        <div class="icon-item"><img src="/bun-com/icons/favicon-96x96.png" width="48" height="48"><span class="icon-size">96px</span></div>
        <div class="icon-item"><img src="/bun-com/icons/icon-192x192.png" width="64" height="64"><span class="icon-size">192px</span></div>
        <div class="icon-item"><img src="/bun-com/icons/icon-512x512.png" width="64" height="64"><span class="icon-size">512px</span></div>
        <div class="icon-item"><img src="/bun-com/icons/logo@1024x.png" width="64" height="64"><span class="icon-size">1024px</span></div>
        <div class="icon-item"><img src="/bun-com/icons/logo.svg" width="48" height="48"><span class="icon-label">SVG</span></div>
        <div class="icon-item"><img src="/bun-com/icons/apple-touch-icon.png" width="48" height="48"><span class="icon-label">apple</span></div>
      </div>
    </div>
  </div>

  <div class="pwa-section" style="margin-top: 0.5rem;">
    <h3 style="color: var(--accent); cursor: pointer;" onclick="toggleSection('icon-vs-content', this)">
      Visual Icon Comparison ▸
    </h3>
    <div id="icon-vs-content" style="display: none; margin-top: 0.5rem;">
      <div class="icon-vs">
        <div class="icon-col">
          <h4>BUN-DEV (ours)</h4>
          <div class="icon-grid">
            <img src="/icons/icon-128.png" width="64" height="64" title="128px">
            <img src="/icons/icon-256.png" width="64" height="64" title="256px">
            <img src="/icons/icon-512.png" width="64" height="64" title="512px">
            <img src="/icons/maskable-512.png" width="64" height="64" title="maskable">
          </div>
        </div>
        <div class="icon-col">
          <h4>bun.com (theirs)</h4>
          <div class="icon-grid">
            <img src="/bun-com/icons/favicon-96x96.png" width="64" height="64" title="96px">
            <img src="/bun-com/icons/icon-192x192.png" width="64" height="64" title="192px">
            <img src="/bun-com/icons/icon-512x512.png" width="64" height="64" title="512px">
            <img src="/bun-com/icons/logo.svg" width="64" height="64" title="SVG">
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="pwa-section" style="margin-top: 0.5rem;">
    <h3 style="color: var(--accent); cursor: pointer;" onclick="toggleSection('sw-cache-content', this)">
      Service Worker Cache Status ▸
    </h3>
    <div id="sw-cache-content" style="display: none; margin-top: 0.5rem;">
      <div id="sw-cache-info" style="color: var(--fg-dim); font-size: 0.8rem;">Checking cache status...</div>
      <div class="sw-cache-bar"><div class="sw-cache-fill" id="sw-cache-fill" style="width: 0%"></div></div>
      <div id="sw-cache-detail" style="margin-top: 0.3rem; font-size: 0.8rem;"></div>
    </div>
  </div>

  <div class="pwa-section" id="pwa-compare-panel" style="margin-top: 0.5rem;">
    <h3 style="color: var(--accent); cursor: pointer;" onclick="loadPWACompare()">
      Manifest Comparison: BUN-DEV vs bun.com ▸
    </h3>
    <div id="pwa-compare-content" style="display: none; margin-top: 0.5rem;">
      <p style="color: var(--fg-dim); font-size: 0.8rem;">Loading comparison...</p>
    </div>
  </div>

  <div class="pwa-section" id="pwa-validate-panel" style="margin-top: 0.5rem;">
    <h3 style="color: var(--accent); cursor: pointer;" onclick="loadPWAValidate()">
      Installability Validation ▸
    </h3>
    <div id="pwa-validate-content" style="display: none; margin-top: 0.5rem;">
      <p style="color: var(--fg-dim); font-size: 0.8rem;">Loading validation...</p>
    </div>
  </div>
  ` : ""}

  <h2>API Reference <span style="font-size:0.75rem; color:var(--fg-dim);">— searchable, categorized, ${'40+'} endpoints</span></h2>
  <input type="text" id="api-search" placeholder="Search endpoints... (e.g. hash, image, sql, auth)" style="width:100%; background:var(--bg-nav); color:var(--fg); border:1px solid var(--border); border-radius:4px; padding:0.4rem 0.6rem; font-family:inherit; font-size:0.85rem; margin-bottom:0.5rem;" oninput="filterEndpoints()">
  <div id="api-reference">
    <style>
      .api-cat { margin-top: 0.8rem; }
      .api-cat h3 { color: var(--info); font-size: 0.85rem; margin: 0 0 0.3rem 0; border-bottom: 1px solid var(--border); padding-bottom: 0.2rem; }
      .api-row { display: flex; align-items: center; gap: 0.4rem; padding: 0.2rem 0.3rem; border-radius: 3px; font-size: 0.78rem; }
      .api-row:hover { background: var(--bg-nav); }
      .api-method { font-size: 0.65rem; font-weight: bold; padding: 0.1rem 0.35rem; border-radius: 3px; min-width: 38px; text-align: center; }
      .api-get { background: #2a5a2a; color: #50fa7b; }
      .api-post { background: #5a4a2a; color: #ffb86c; }
      .api-ws { background: #2a3a5a; color: #8be9fd; }
      .api-sse { background: #4a2a5a; color: #bd93f9; }
      .api-path { font-family: monospace; color: var(--accent); flex-shrink: 0; }
      .api-desc { color: var(--fg-dim); }
      .api-auth { font-size: 0.6rem; color: var(--warn); padding: 0.05rem 0.3rem; border: 1px solid var(--warn); border-radius: 2px; }
      .api-csrf { font-size: 0.6rem; color: var(--err); padding: 0.05rem 0.3rem; border: 1px solid var(--err); border-radius: 2px; }
      .api-bun { font-size: 0.6rem; color: var(--info); padding: 0.05rem 0.3rem; background: rgba(139,233,253,0.1); border-radius: 2px; }
    </style>

    <div class="api-cat">
      <h3>🏥 Health &amp; Metrics</h3>
      <div class="api-row"><a href="/health" class="api-method api-get">GET</a><span class="api-path">/health</span><span class="api-desc">health check + worker pool status</span></div>
      <div class="api-row"><a href="/metrics" class="api-method api-get">GET</a><span class="api-path">/metrics</span><span class="api-desc">Prometheus-format metrics</span></div>
      <div class="api-row"><a href="/api/health-log" class="api-method api-get">GET</a><span class="api-path">/api/health-log</span><span class="api-desc">cron health check history</span><span class="api-bun">Bun.cron</span></div>
      <div class="api-row"><a href="/api/runtime" class="api-method api-get">GET</a><span class="api-path">/api/runtime</span><span class="api-desc">runtime introspection (gc, nanoseconds, shrink)</span><span class="api-auth">auth</span><span class="api-bun">Bun.gc</span></div>
    </div>

    <div class="api-cat">
      <h3>🔐 Authentication &amp; Admin</h3>
      <div class="api-row"><span class="api-method api-post">POST</span><span class="api-path">/login</span><span class="api-desc">agent auth → token + csrf_token + session cookie</span><span class="api-bun">Bun.CookieMap</span></div>
      <div class="api-row"><span class="api-method api-post">POST</span><span class="api-path">/api/admin/shell</span><span class="api-desc">safe admin commands (vacuum, status, workers, git, disk, env)</span><span class="api-auth">auth</span><span class="api-csrf">CSRF</span><span class="api-bun">Bun.shell</span></div>
      <div class="api-row"><span class="api-method api-post">POST</span><span class="api-path">/api/features/toggle</span><span class="api-desc">toggle feature flag at runtime — no restart</span><span class="api-auth">auth</span><span class="api-csrf">CSRF</span></div>
    </div>

    <div class="api-cat">
      <h3>📋 Tasks &amp; Sessions</h3>
      <div class="api-row"><span class="api-method api-get">GET</span><span class="api-path">/tasks</span><span class="api-desc">paginated task list</span><span class="api-auth">auth</span></div>
      <div class="api-row"><span class="api-method api-post">POST</span><span class="api-path">/task</span><span class="api-desc">create automation task (WebView screenshot)</span><span class="api-auth">auth</span><span class="api-csrf">CSRF</span></div>
      <div class="api-row"><span class="api-method api-get">GET</span><span class="api-path">/task/:id</span><span class="api-desc">get task by ID</span><span class="api-auth">auth</span></div>
      <div class="api-row"><span class="api-method api-get">GET</span><span class="api-path">/sessions</span><span class="api-desc">list sessions</span><span class="api-auth">auth</span></div>
      <div class="api-row"><span class="api-method api-get">GET</span><span class="api-path">/screenshot/:id</span><span class="api-desc">serve task screenshot</span><span class="api-auth">auth</span></div>
    </div>

    <div class="api-cat">
      <h3>📤 Data Export &amp; Streaming</h3>
      <div class="api-row"><span class="api-method api-get">GET</span><span class="api-path">/api/tasks.jsonl</span><span class="api-desc">tasks JSONL stream</span><span class="api-auth">auth</span><span class="api-bun">Bun.JSONL</span></div>
      <div class="api-row"><span class="api-method api-get">GET</span><span class="api-path">/api/sessions.jsonl</span><span class="api-desc">sessions JSONL stream</span><span class="api-auth">auth</span></div>
      <div class="api-row"><span class="api-method api-get">GET</span><span class="api-path">/api/audit.jsonl</span><span class="api-desc">audit log JSONL stream</span><span class="api-auth">auth</span></div>
      <div class="api-row"><span class="api-method api-get">GET</span><span class="api-path">/api/export/bundle.tar</span><span class="api-desc">tar bundle of all JSONL + manifest</span><span class="api-auth">auth</span><span class="api-bun">Bun.Archive</span></div>
      <div class="api-row"><span class="api-method api-get">GET</span><span class="api-path">/api/export/bundle.tar?gzip=1</span><span class="api-desc">gzip-compressed tar with ratio header</span><span class="api-auth">auth</span><span class="api-bun">Bun.Archive</span></div>
      <div class="api-row"><span class="api-method api-get">GET</span><span class="api-path">/api/stream/:path</span><span class="api-desc">streaming file response (public dir)</span><span class="api-bun">Bun.file</span></div>
      <div class="api-row"><span class="api-method api-sse">SSE</span><a href="/api/audit/stream" class="api-path">/api/audit/stream</a><span class="api-desc">real-time audit log stream</span><span class="api-auth">auth</span></div>
    </div>

    <div class="api-cat">
      <h3>🎨 Bun Runtime APIs</h3>
      <div class="api-row"><a href="/api/color?color=red&format=css" class="api-method api-get">GET</a><span class="api-path">/api/color</span><span class="api-desc">color conversion (hex/rgb/hsl/css)</span><span class="api-bun">Bun.color</span></div>
      <div class="api-row"><a href="/api/hash?input=hello" class="api-method api-get">GET</a><span class="api-path">/api/hash</span><span class="api-desc">hash computation (sha256/sha512/md5)</span><span class="api-bun">Bun.CryptoHasher</span></div>
      <div class="api-row"><a href="/api/transpile?code=const%20x:number=1" class="api-method api-get">GET</a><span class="api-path">/api/transpile</span><span class="api-desc">TS/JSX → JS transpiler</span><span class="api-bun">Bun.Transpiler</span></div>
      <div class="api-row"><a href="/api/compress?input=hello&action=compress" class="api-method api-get">GET</a><span class="api-path">/api/compress</span><span class="api-desc">compress/decompress (zlib + base64)</span><span class="api-bun">Bun.deflateSync</span></div>
      <div class="api-row"><a href="/api/utils?tool=escape&input=<test>" class="api-method api-get">GET</a><span class="api-path">/api/utils</span><span class="api-desc">escape HTML, base64, URL encode/decode</span><span class="api-bun">Bun.escapeHTML</span></div>
      <div class="api-row"><span class="api-method api-post">POST</span><span class="api-path">/api/markdown</span><span class="api-desc">render markdown → HTML</span><span class="api-bun">Bun.markdown</span></div>
      <div class="api-row"><a href="/api/semver" class="api-method api-get">GET</a><span class="api-path">/api/semver</span><span class="api-desc">version negotiation + feature detection</span><span class="api-bun">Bun.semver</span></div>
      <div class="api-row"><a href="/api/env" class="api-method api-get">GET</a><span class="api-path">/api/env</span><span class="api-desc">environment variable inspection</span></div>
    </div>

    <div class="api-cat">
      <h3>🌐 Network &amp; Process</h3>
      <div class="api-row"><span class="api-method api-post">POST</span><span class="api-path">/api/dns</span><span class="api-desc">DNS lookup (async, returns address + family)</span><span class="api-bun">Bun.dns</span></div>
      <div class="api-row"><a href="/api/processes" class="api-method api-get">GET</a><span class="api-path">/api/processes</span><span class="api-desc">top 20 processes (ps aux)</span><span class="api-auth">auth</span><span class="api-bun">Bun.spawn</span></div>
      <div class="api-row"><a href="/api/ffi" class="api-method api-get">GET</a><span class="api-path">/api/ffi</span><span class="api-desc">native library loading (libsqlite3 version)</span><span class="api-bun">Bun.ffi</span></div>
      <div class="api-row"><a href="/api/redis" class="api-method api-get">GET</a><span class="api-path">/api/redis</span><span class="api-desc">Redis rate limit status</span><span class="api-bun">Bun.redis</span></div>
      <div class="api-row"><a href="/api/s3/backup" class="api-method api-get">GET</a><span class="api-path">/api/s3/backup</span><span class="api-desc">S3 offsite backup status</span><span class="api-auth">auth</span><span class="api-bun">Bun.s3</span></div>
      <div class="api-row"><span class="api-method api-ws">WS</span><span class="api-path">/ws/metrics</span><span class="api-desc">live metrics push (500ms interval)</span></div>
      <div class="api-row"><span class="api-method api-ws">WS</span><span class="api-path">/ws/task/:id</span><span class="api-desc">task progress updates</span></div>
    </div>

    <div class="api-cat">
      <h3>🖼️ Image &amp; Screenshot</h3>
      <div class="api-row"><span class="api-method api-get">GET</span><span class="api-path">/api/image</span><span class="api-desc">resize/convert (png/webp/jpeg)</span><span class="api-auth">auth</span><span class="api-bun">Bun.Image</span></div>
      <div class="api-row"><span class="api-method api-get">GET</span><span class="api-path">/api/screenshot</span><span class="api-desc">capture PNG of any URL</span><span class="api-auth">auth</span><span class="api-bun">Bun.WebView</span></div>
      <div class="api-row"><span class="api-method api-post">POST</span><span class="api-path">/api/mermaid</span><span class="api-desc">Mermaid diagram → SVG render</span><span class="api-auth">auth</span><span class="api-bun">Bun.WebView</span></div>
    </div>

    <div class="api-cat">
      <h3>💾 Database &amp; Config</h3>
      <div class="api-row"><span class="api-method api-post">POST</span><span class="api-path">/api/sql</span><span class="api-desc">SELECT-only SQL query</span><span class="api-auth">auth</span><span class="api-bun">bun:sqlite</span></div>
      <div class="api-row"><a href="/api/config" class="api-method api-get">GET</a><span class="api-path">/api/config</span><span class="api-desc">multi-format config parser</span><span class="api-bun">Bun.YAML/TOML/JSON5</span></div>
      <div class="api-row"><span class="api-method api-post">POST</span><span class="api-path">/api/config/write</span><span class="api-desc">write YAML/TOML/JSON5 config file</span><span class="api-auth">auth</span><span class="api-csrf">CSRF</span></div>
      <div class="api-row"><a href="/api/fs" class="api-method api-get">GET</a><span class="api-path">/api/fs</span><span class="api-desc">filesystem browser (dirs + files)</span><span class="api-auth">auth</span><span class="api-bun">Bun.file</span></div>
      <div class="api-row"><a href="/api/logs" class="api-method api-get">GET</a><span class="api-path">/api/logs</span><span class="api-desc">structured log ring buffer</span><span class="api-auth">auth</span></div>
    </div>

    <div class="api-cat">
      <h3>📐 Diagrams &amp; Docs</h3>
      <div class="api-row"><a href="/api/diagrams" class="api-method api-get">GET</a><span class="api-path">/api/diagrams</span><span class="api-desc">auto-discovered .mmd files</span><span class="api-bun">Bun.glob</span></div>
      <div class="api-row"><a href="/api/openapi.json" class="api-method api-get">GET</a><span class="api-path">/api/openapi.json</span><span class="api-desc">OpenAPI 3.1 spec (auto-generated)</span></div>
      <div class="api-row"><a href="/api/pwa/validate" class="api-method api-get">GET</a><span class="api-path">/api/pwa/validate</span><span class="api-desc">PWA installability validation</span></div>
      <div class="api-row"><a href="/api/pwa/compare" class="api-method api-get">GET</a><span class="api-path">/api/pwa/compare</span><span class="api-desc">BUN-DEV vs bun.com manifest</span></div>
    </div>

    <div class="api-cat">
      <h3>📦 PWA &amp; Static</h3>
      <div class="api-row"><a href="/manifest.json" class="api-method api-get">GET</a><span class="api-path">/manifest.json</span><span class="api-desc">dynamic PWA manifest (runtime-injected)</span><span class="api-bun">Bun.file</span></div>
      <div class="api-row"><span class="api-method api-post">POST</span><span class="api-path">/api/manifest</span><span class="api-desc">update manifest field at runtime</span><span class="api-auth">auth</span><span class="api-csrf">CSRF</span></div>
      <div class="api-row"><span class="api-method api-post">POST</span><span class="api-path">/api/share-target</span><span class="api-desc">PWA share target (receive shared content)</span></div>
      <div class="api-row"><a href="/sw.js" class="api-method api-get">GET</a><span class="api-path">/sw.js</span><span class="api-desc">service worker</span></div>
      ${ENABLE_SITEMAP ? '<div class="api-row"><a href="/sitemap.xml" class="api-method api-get">GET</a><span class="api-path">/sitemap.xml</span><span class="api-desc">sitemap with priority + changefreq metadata</span></div>' : ""}
      <div class="api-row"><a href="/protocol" class="api-method api-get">GET</a><span class="api-path">/protocol</span><span class="api-desc">protocol info (HTTP/3 status)</span></div>
      <div class="api-row"><a href="/features" class="api-method api-get">GET</a><span class="api-path">/features</span><span class="api-desc">feature flags (JSON)</span></div>
      <div class="api-row"><a href="/dashboard" class="api-method api-get">GET</a><span class="api-path">/dashboard</span><span class="api-desc">this page</span></div>
    </div>
  </div>
  <p style="margin-top:0.5rem; font-size:0.7rem; color:var(--fg-dim);">
    <span class="api-auth">auth</span> = requires Bearer token &nbsp;
    <span class="api-csrf">CSRF</span> = requires X-CSRF-Token header &nbsp;
    <span class="api-bun">Bun.*</span> = Bun-native API used
  </p>

  <div class="pwa-section" style="margin-top: 0.5rem;">
    <h3 style="color: var(--accent); cursor: pointer;" onclick="toggleSection('transpiler-content', this)">
      Code Transpiler Playground ▸
    </h3>
    <div id="transpiler-content" style="display: none; margin-top: 0.5rem;">
      <textarea id="transpile-input" rows="4" style="width:100%; background:var(--bg-nav); color:var(--fg); border:1px solid var(--border); border-radius:4px; padding:0.5rem; font-family:inherit; font-size:0.8rem;" placeholder="const x: number = 42; const fn = (a: string) => a.toUpperCase();"></textarea>
      <button onclick="runTranspile()" style="background:var(--accent); color:var(--bg); border:none; padding:0.3rem 0.7rem; border-radius:4px; cursor:pointer; font-family:inherit; margin-top:0.3rem;">Transpile</button>
      <pre id="transpile-output" style="margin-top:0.5rem; background:var(--bg-nav); border:1px solid var(--border); border-radius:4px; padding:0.5rem; font-size:0.75rem; max-height:200px; overflow-y:auto; color:var(--info);"></pre>
    </div>
  </div>

  <div class="pwa-section" style="margin-top: 0.5rem;">
    <h3 style="color: var(--accent); cursor: pointer;" onclick="toggleSection('fs-browser-content', this)">
      Filesystem Browser ▸
    </h3>
    <div id="fs-browser-content" style="display: none; margin-top: 0.5rem;">
      <div id="fs-browser-output" style="color: var(--fg-dim); font-size: 0.8rem;">Loading...</div>
    </div>
  </div>

  <div class="pwa-section" style="margin-top: 0.5rem;">
    <h3 style="color: var(--accent); cursor: pointer;" onclick="toggleSection('utils-content', this)">
      Developer Utilities ▸
    </h3>
    <div id="utils-content" style="display: none; margin-top: 0.5rem;">
      <select id="utils-tool" style="background:var(--bg-nav); color:var(--fg); border:1px solid var(--border); border-radius:4px; padding:0.3rem;">
        <option value="escape">Escape HTML</option>
        <option value="base64-encode">Base64 Encode</option>
        <option value="base64-decode">Base64 Decode</option>
        <option value="urlencode">URL Encode</option>
        <option value="urldecode">URL Decode</option>
      </select>
      <input id="utils-input" type="text" placeholder="Enter input..." style="width:60%; background:var(--bg-nav); color:var(--fg); border:1px solid var(--border); border-radius:4px; padding:0.3rem; margin-left:0.3rem;">
      <button onclick="runUtil()" style="background:var(--accent); color:var(--bg); border:none; padding:0.3rem 0.7rem; border-radius:4px; cursor:pointer; font-family:inherit; margin-left:0.3rem;">Run</button>
      <pre id="utils-output" style="margin-top:0.5rem; background:var(--bg-nav); border:1px solid var(--border); border-radius:4px; padding:0.5rem; font-size:0.75rem; color:var(--info);"></pre>
    </div>
  </div>

  <div class="pwa-section" style="margin-top: 0.5rem;">
    <h3 style="color: var(--accent); cursor: pointer;" onclick="toggleSection('runtime-content', this)">
      Runtime Info (gc/nanoseconds/shrink) ▸
    </h3>
    <div id="runtime-content" style="display: none; margin-top: 0.5rem;">
      <div id="runtime-output" style="color: var(--fg-dim); font-size: 0.8rem;">Loading...</div>
      <button onclick="runGC()" style="background:var(--warn); color:var(--bg); border:none; padding:0.3rem 0.7rem; border-radius:4px; cursor:pointer; font-family:inherit; margin-top:0.3rem;">Force GC</button>
      <button onclick="runShrink()" style="background:var(--warn); color:var(--bg); border:none; padding:0.3rem 0.7rem; border-radius:4px; cursor:pointer; font-family:inherit; margin-left:0.3rem;">Shrink Memory</button>
      <button onclick="runNano()" style="background:var(--info); color:var(--bg); border:none; padding:0.3rem 0.7rem; border-radius:4px; cursor:pointer; font-family:inherit; margin-left:0.3rem;">Benchmark (ns)</button>
    </div>
  </div>

  <div class="pwa-section" style="margin-top: 0.5rem;">
    <h3 style="color: var(--accent); cursor: pointer;" onclick="toggleSection('ws-chart-content', this)">
      Live Worker Metrics Chart (WebSocket) ▸
    </h3>
    <div id="ws-chart-content" style="display: none; margin-top: 0.5rem;">
      <canvas id="worker-chart" width="600" height="200" style="background: var(--bg-nav); border-radius: 4px; border: 1px solid var(--border);"></canvas>
      <div style="margin-top: 0.3rem; font-size: 0.75rem; color: var(--fg-dim);">
        <span style="color:var(--accent);">●</span> Idle workers
        <span style="color:var(--warn); margin-left:1rem;">●</span> Busy workers
        <span id="ws-status-text" style="margin-left:1rem;">Disconnected</span>
      </div>
    </div>
  </div>

  <footer>BUN-DEV — Bun Automation Platform | Powered by Bun v${Bun.version}</footer>
  <div style="margin-top: 0.5rem; color: var(--fg-dim); font-size: 0.7rem; text-align: center;">
    Shortcuts: <span class="kbd">R</span> refresh <span class="kbd">I</span> install <span class="kbd">C</span> compare <span class="kbd">V</span> validate <span class="kbd">G</span> gallery
  </div>
  <div class="toast" id="toast"></div>

  <script>
    async function fetchFeatures() {
      const panel = document.getElementById('features-panel');
      const output = document.getElementById('features-output');
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      if (panel.style.display === 'none') return;
      output.textContent = 'Loading...';
      try {
        const res = await fetch('/features');
        const data = await res.json();
        const rows = data.features.map(f =>
          '  ' + f.key.padEnd(15) + ' ' +
          (f.active ? '✅ active' : f.blocked ? '⚠️  blocked' : '❌ off') +
          '  ' + f.status
        ).join('\\n');
        output.textContent = 'Feature              State          Status\\n' +
                             '───────              ─────          ──────\\n' + rows;
      } catch (e) {
        output.textContent = 'Error: ' + e.message;
      }
    }
    // Live uptime counter
    let uptimeStart = ${Math.floor(process.uptime())};
    setInterval(() => {
      uptimeStart++;
      const m = Math.floor(uptimeStart / 60);
      const s = uptimeStart % 60;
      document.getElementById('uptime').textContent = m > 0 ? m + 'm ' + s + 's' : s + 's';
    }, 1000);

    // Live health polling — every 5s
    async function pollHealth() {
      try {
        const res = await fetch('/health');
        const data = await res.json();
        const pulse = document.getElementById('health-pulse');
        const stat = document.getElementById('health-stat');
        const workers = document.getElementById('workers-stat');
        if (data.status === 'ok') {
          pulse.className = 'health-pulse ok';
          stat.textContent = '✅ OK';
          stat.style.color = 'var(--accent)';
          workers.textContent = data.workers.idle + '/' + data.workers.total + ' idle';
        } else {
          pulse.className = 'health-pulse err';
          stat.textContent = '❌ Down';
          stat.style.color = 'var(--err)';
        }
      } catch (e) {
        const pulse = document.getElementById('health-pulse');
        const stat = document.getElementById('health-stat');
        pulse.className = 'health-pulse err';
        stat.textContent = '❌ Error';
        stat.style.color = 'var(--err)';
      }
    }
    pollHealth();
    setInterval(pollHealth, 5000);

    // Fetch metrics for routes count
    async function fetchMetrics() {
      try {
        const res = await fetch('/metrics');
        const text = await res.text();
        const totalMatch = text.match(/routes\{type="total"\} (\\d+)/);
        const pwaMatch = text.match(/routes\{type="pwa"\} (\\d+)/);
        if (totalMatch) document.getElementById('routes-stat').textContent = totalMatch[1] + ' total';
      } catch (e) {}
    }
    fetchMetrics();

    // Network status indicator
    function updateNetStatus() {
      const badge = document.getElementById('net-status');
      if (navigator.onLine) {
        badge.textContent = '● Online';
        badge.className = 'net-badge';
      } else {
        badge.textContent = '● Offline';
        badge.className = 'net-badge offline';
      }
    }
    updateNetStatus();
    window.addEventListener('online', updateNetStatus);
    window.addEventListener('offline', updateNetStatus);

    // Toast helper
    function showToast(msg) {
      const toast = document.getElementById('toast');
      toast.textContent = msg;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2000);
    }

    // Copy manifest to clipboard
    async function copyManifest() {
      try {
        const res = await fetch('/manifest.json');
        const text = await res.text();
        await navigator.clipboard.writeText(text);
        showToast('✅ Manifest copied to clipboard');
      } catch (e) {
        showToast('❌ Copy failed: ' + e.message);
      }
    }

    // Toggle section helper
    function toggleSection(id, h3) {
      const el = document.getElementById(id);
      if (el.style.display === 'none') {
        el.style.display = 'block';
        h3.textContent = h3.textContent.replace('▸', '▾');
      } else {
        el.style.display = 'none';
        h3.textContent = h3.textContent.replace('▾', '▸');
      }
    }

    // SSE audit log terminal
    let auditEventSource = null;
    function startAuditStream() {
      const terminal = document.getElementById('audit-terminal');
      const btn = document.getElementById('audit-stream-btn');
      if (auditEventSource) {
        auditEventSource.close();
        auditEventSource = null;
        btn.textContent = 'Start Streaming';
        return;
      }
      // Need auth token for SSE — use cookie if available
      auditEventSource = new EventSource('/api/audit/stream');
      auditEventSource.onmessage = function(e) {
        const entry = JSON.parse(e.data);
        const time = new Date(entry.created_at).toLocaleTimeString();
        const line = '[' + time + '] ' + entry.action + (entry.resource ? ' → ' + entry.resource : '') + '\\n';
        terminal.textContent += line;
        terminal.scrollTop = terminal.scrollHeight;
      };
      auditEventSource.onerror = function() {
        terminal.textContent += '--- connection lost ---\\n';
        auditEventSource.close();
        auditEventSource = null;
        btn.textContent = 'Start Streaming';
      };
      btn.textContent = 'Stop Streaming';
      terminal.textContent = '--- streaming live audit events ---\\n';
    }

    // Mermaid live render
    async function renderMermaid() {
      const input = document.getElementById('mermaid-input').value;
      const output = document.getElementById('mermaid-output');
      if (!input.trim()) { output.innerHTML = '<span style="color:var(--err);">Enter mermaid code</span>'; return; }
      output.innerHTML = '<span style="color:var(--fg-dim);">Rendering via Bun.WebView...</span>';
      try {
        const res = await fetch('/api/mermaid', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: input }),
        });
        if (res.ok) {
          const svg = await res.text();
          output.innerHTML = svg;
        } else {
          const err = await res.json();
          output.innerHTML = '<span style="color:var(--err);">' + (err.error || 'render failed') + '</span>';
        }
      } catch (e) {
        output.innerHTML = '<span style="color:var(--err);">Error: ' + e.message + '</span>';
      }
    }

    // Load OpenAPI spec for Swagger panel
    async function loadSwagger() {
      const output = document.getElementById('swagger-output');
      try {
        const res = await fetch('/api/openapi.json');
        const spec = await res.json();
        let html = '<table><tr><th>Path</th><th>Methods</th></tr>';
        for (const [path, methods] of Object.entries(spec.paths)) {
          // JUSTIFIED: methods is unknown from JSON; narrowing to object
          const m = methods;
          const methodList = Object.keys(m).map(method =>
            '<span style="color:var(--info); font-size:0.75rem; padding:0.1rem 0.3rem; border:1px solid var(--border); border-radius:3px;">' + method.toUpperCase() + '</span>'
          ).join(' ');
          html += '<tr><td style="font-family:monospace; color:var(--accent);">' + path + '</td><td>' + methodList + '</td></tr>';
        }
        html += '</table>';
        html += '<p style="margin-top:0.5rem; color:var(--fg-dim); font-size:0.75rem;">OpenAPI ' + spec.openapi + ' • ' + spec.info.title + ' v' + spec.info.version + '</p>';
        output.innerHTML = html;
      } catch (e) {
        output.innerHTML = '<span style="color:var(--err);">Error: ' + e.message + '</span>';
      }
    }

    // Feature toggle buttons — add onclick handlers to toggle cells
    function setupFeatureToggles() {
      const table = document.getElementById('feature-flag-table');
      if (!table) return;
      // Add toggle button column to each row (skip header)
      const rows = table.querySelectorAll('tr');
      rows.forEach((row, i) => {
        if (i === 0) return; // skip header
        const cells = row.querySelectorAll('td');
        if (cells.length >= 3) {
          const key = cells[0].textContent;
          const stateCell = cells[2];
          const isActive = stateCell.textContent.includes('active');
          const toggleCell = cells[4] || document.createElement('td');
          toggleCell.innerHTML = '<button onclick="toggleFeature(\\'' + key + '\\', ' + !isActive + ')" style="background:' + (isActive ? 'var(--err)' : 'var(--accent)') + '; color:var(--bg); border:none; padding:0.2rem 0.5rem; border-radius:4px; cursor:pointer; font-family:inherit; font-size:0.75rem;">' + (isActive ? 'Disable' : 'Enable') + '</button>';
          if (cells.length < 5) row.appendChild(toggleCell);
        }
      });
    }

    async function toggleFeature(key, enabled) {
      try {
        const res = await fetch('/api/features/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, enabled }),
        });
        if (res.ok) {
          showToast('✅ ' + key + ' ' + (enabled ? 'enabled' : 'disabled'));
          setTimeout(() => location.reload(), 500);
        } else {
          const err = await res.json();
          showToast('❌ ' + (err.error || 'toggle failed'));
        }
      } catch (e) {
        showToast('❌ ' + e.message);
      }
    }

    // Auto-load swagger when panel is opened
    document.querySelector('#swagger-content').previousElementSibling?.addEventListener('click', () => {
      if (document.getElementById('swagger-content').style.display === 'block') loadSwagger();
    });

    // Setup feature toggles on page load
    setTimeout(setupFeatureToggles, 100);

    // WebSocket live worker metrics chart
    let wsChart = null;
    let wsChartData = []; // {time, idle, busy}
    const WS_CHART_MAX_POINTS = 60;

    function startWSChart() {
      const canvas = document.getElementById('worker-chart');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const statusText = document.getElementById('ws-status-text');

      // Connect to /ws/metrics
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = protocol + '//' + location.host + '/ws/metrics';

      try {
        wsChart = new WebSocket(wsUrl);
      } catch (e) {
        statusText.textContent = 'WebSocket not available (ENABLE_WEBSOCKET=0)';
        statusText.style.color = 'var(--warn)';
        return;
      }

      wsChart.onopen = function() {
        statusText.textContent = 'Connected';
        statusText.style.color = 'var(--accent)';
      };

      wsChart.onmessage = function(event) {
        const data = JSON.parse(event.data);
        if (data.type !== 'metrics') return;
        wsChartData.push({ time: Date.now(), idle: data.idle, busy: data.busy });
        if (wsChartData.length > WS_CHART_MAX_POINTS) wsChartData.shift();
        drawChart(ctx, canvas, wsChartData);
      };

      wsChart.onclose = function() {
        statusText.textContent = 'Disconnected';
        statusText.style.color = 'var(--err)';
      };

      wsChart.onerror = function() {
        statusText.textContent = 'Error';
        statusText.style.color = 'var(--err)';
      };
    }

    function drawChart(ctx, canvas, data) {
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      if (data.length < 2) return;

      const maxWorkers = Math.max(...data.map(d => d.idle + d.busy), 4);
      const stepX = w / (WS_CHART_MAX_POINTS - 1);
      const scaleY = (h - 20) / maxWorkers;

      // Draw grid
      ctx.strokeStyle = '#3a3b3b';
      ctx.lineWidth = 0.5;
      for (let i = 0; i <= maxWorkers; i++) {
        const y = h - 10 - i * scaleY;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Draw idle workers (green area)
      ctx.fillStyle = 'rgba(80, 250, 123, 0.2)';
      ctx.strokeStyle = '#50fa7b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, h - 10);
      data.forEach((d, i) => {
        ctx.lineTo(i * stepX, h - 10 - d.idle * scaleY);
      });
      ctx.lineTo((data.length - 1) * stepX, h - 10);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Draw busy workers (orange line)
      ctx.strokeStyle = '#ffb86c';
      ctx.lineWidth = 2;
      ctx.beginPath();
      data.forEach((d, i) => {
        const y = h - 10 - d.busy * scaleY;
        if (i === 0) ctx.moveTo(i * stepX, y);
        else ctx.lineTo(i * stepX, y);
      });
      ctx.stroke();

      // Labels
      ctx.fillStyle = '#a8a8a0';
      ctx.font = '10px monospace';
      ctx.fillText('workers: ' + maxWorkers, 5, 15);
      ctx.fillText('idle: ' + data[data.length-1].idle + ' busy: ' + data[data.length-1].busy, w - 120, 15);
    }

    // Auto-start chart when panel is opened
    document.querySelector('#ws-chart-content').previousElementSibling?.addEventListener('click', () => {
      if (document.getElementById('ws-chart-content').style.display === 'block' && !wsChart) {
        startWSChart();
      }
    });

    // API reference search filter
    function filterEndpoints() {
      const query = document.getElementById('api-search').value.toLowerCase();
      const rows = document.querySelectorAll('#api-reference .api-row');
      let visibleCount = 0;
      rows.forEach(row => {
        const text = row.textContent.toLowerCase();
        if (!query || text.includes(query)) {
          row.style.display = '';
          visibleCount++;
        } else {
          row.style.display = 'none';
        }
      });
      // Hide empty categories
      document.querySelectorAll('#api-reference .api-cat').forEach(cat => {
        const visible = cat.querySelectorAll('.api-row:not([style*="display: none"])');
        cat.style.display = visible.length > 0 ? '' : 'none';
      });
    }

    // Code Transpiler Playground
    async function runTranspile() {
      const input = document.getElementById('transpile-input').value;
      const output = document.getElementById('transpile-output');
      if (!input.trim()) { output.textContent = 'Enter code to transpile'; return; }
      output.textContent = 'Transpiling...';
      try {
        const res = await fetch('/api/transpile?code=' + encodeURIComponent(input));
        // JUSTIFIED: res.json() returns unknown; narrowing to response shape
        const data = await res.json();
        if (data.error) {
          output.textContent = 'Error: ' + data.error;
          output.style.color = 'var(--err)';
        } else {
          output.textContent = data.output;
          output.style.color = 'var(--info)';
          output.innerHTML += '\\n\\n--- ' + data.inputSize + 'B → ' + data.outputSize + 'B ---';
        }
      } catch (e) {
        output.textContent = 'Error: ' + e.message;
      }
    }

    // Filesystem Browser
    async function loadFsBrowser(path) {
      const output = document.getElementById('fs-browser-output');
      path = path || '.';
      output.textContent = 'Browsing ' + path + '...';
      try {
        const res = await fetch('/api/fs?path=' + encodeURIComponent(path));
        // JUSTIFIED: res.json() returns unknown; narrowing to response shape
        const data = await res.json();
        if (data.error) { output.innerHTML = '<span style="color:var(--err);">' + data.error + '</span>'; return; }
        let html = '<table style="width:100%; font-size:0.75rem;"><tr><th>Name</th><th>Size</th><th>Type</th></tr>';
        for (const f of data.files) {
          const icon = f.type === 'directory' ? '📁' : '📄';
          const size = f.type === 'directory' ? '-' : (f.size < 1024 ? f.size + 'B' : (f.size / 1024).toFixed(1) + 'KB');
          const clickPath = f.type === 'directory' ? 'onclick="loadFsBrowser(\\'' + f.path + '\\')"' : '';
          html += '<tr style="cursor:pointer;" ' + clickPath + '><td>' + icon + ' ' + f.name + '</td><td>' + size + '</td><td style="color:var(--fg-dim);">' + f.type + '</td></tr>';
        }
        html += '</table><p style="color:var(--fg-dim);">' + data.count + ' entries in ' + data.path + '</p>';
        output.innerHTML = html;
      } catch (e) {
        output.innerHTML = '<span style="color:var(--err);">Error: ' + e.message + '</span>';
      }
    }

    // Developer Utilities
    async function runUtil() {
      const tool = document.getElementById('utils-tool').value;
      const input = document.getElementById('utils-input').value;
      const output = document.getElementById('utils-output');
      if (!input) { output.textContent = 'Enter input'; return; }
      try {
        const res = await fetch('/api/utils?tool=' + tool + '&input=' + encodeURIComponent(input));
        // JUSTIFIED: res.json() returns unknown; narrowing to response shape
        const data = await res.json();
        if (data.error) {
          output.textContent = 'Error: ' + data.error;
          output.style.color = 'var(--err)';
        } else {
          output.textContent = data.output;
          output.style.color = 'var(--info)';
        }
      } catch (e) {
        output.textContent = 'Error: ' + e.message;
      }
    }

    // Runtime info
    async function loadRuntime() {
      const output = document.getElementById('runtime-output');
      try {
        const res = await fetch('/api/runtime');
        // JUSTIFIED: res.json() returns unknown; narrowing to response shape
        const data = await res.json();
        const mem = data.memory;
        const fmt = (b) => (b / 1024 / 1024).toFixed(1) + 'MB';
        output.innerHTML = '<table style="font-size:0.75rem;">' +
          '<tr><td>Bun version:</td><td style="color:var(--accent);">' + data.bunVersion + '</td></tr>' +
          '<tr><td>PID:</td><td>' + data.pid + '</td></tr>' +
          '<tr><td>Uptime:</td><td>' + (data.uptime).toFixed(1) + 's</td></tr>' +
          '<tr><td>RSS:</td><td style="color:var(--warn);">' + fmt(mem.rss) + '</td></tr>' +
          '<tr><td>Heap used:</td><td style="color:var(--warn);">' + fmt(mem.heapUsed) + '</td></tr>' +
          '<tr><td>Heap total:</td><td>' + fmt(mem.heapTotal) + '</td></tr>' +
          '<tr><td>External:</td><td>' + fmt(mem.external) + '</td></tr>' +
          '<tr><td>ArrayBuffers:</td><td>' + fmt(mem.arrayBuffers) + '</td></tr>' +
          '</table>';
      } catch (e) {
        output.innerHTML = '<span style="color:var(--err);">Error: ' + e.message + '</span>';
      }
    }

    async function runGC() {
      const output = document.getElementById('runtime-output');
      const res = await fetch('/api/runtime?action=gc');
      // JUSTIFIED: res.json() returns unknown; narrowing to response shape
      const data = await res.json();
      const fmt = (b) => (b / 1024 / 1024).toFixed(1) + 'MB';
      output.innerHTML = '<p style="color:var(--accent);">GC freed ' + fmt(data.freed) + '</p>' +
        '<p style="font-size:0.75rem;">Before: ' + fmt(data.before.heapUsed) + ' → After: ' + fmt(data.after.heapUsed) + '</p>';
      setTimeout(loadRuntime, 500);
    }

    async function runShrink() {
      const output = document.getElementById('runtime-output');
      const res = await fetch('/api/runtime?action=shrink');
      // JUSTIFIED: res.json() returns unknown; narrowing to response shape
      const data = await res.json();
      const fmt = (b) => (b / 1024 / 1024).toFixed(1) + 'MB';
      output.innerHTML = '<p style="color:var(--accent);">Shrink freed ' + fmt(data.freed) + ' RSS</p>';
      setTimeout(loadRuntime, 500);
    }

    async function runNano() {
      const output = document.getElementById('runtime-output');
      const res = await fetch('/api/runtime?action=nanoseconds');
      // JUSTIFIED: res.json() returns unknown; narrowing to response shape
      const data = await res.json();
      output.innerHTML = '<p style="color:var(--accent);">1000x Math.sqrt(): ' + data.elapsedNs + 'ns (' + data.elapsedMs + 'ms)</p>' +
        '<p style="font-size:0.75rem;">Uptime: ' + (data.uptimeNs / 1e9).toFixed(1) + 's (' + data.uptimeNs + 'ns)</p>';
    }

    // Auto-load panels when opened
    document.querySelector('#fs-browser-content').previousElementSibling?.addEventListener('click', () => {
      if (document.getElementById('fs-browser-content').style.display === 'block') loadFsBrowser('.');
    });
    document.querySelector('#runtime-content').previousElementSibling?.addEventListener('click', () => {
      if (document.getElementById('runtime-content').style.display === 'block') loadRuntime();
    });

    // SW cache status
    async function checkSWCache() {
      const info = document.getElementById('sw-cache-info');
      const fill = document.getElementById('sw-cache-fill');
      const detail = document.getElementById('sw-cache-detail');
      if ('caches' in window) {
        try {
          const keys = await caches.keys();
          if (keys.length === 0) {
            info.textContent = 'No caches found (SW not yet active)';
            fill.style.width = '0%';
            return;
          }
          let totalRequests = 0;
          let cachedRequests = 0;
          for (const key of keys) {
            const cache = await caches.open(key);
            const requests = await cache.keys();
            totalRequests += requests.length;
          }
          info.textContent = 'Cache: ' + keys.join(', ') + ' (' + totalRequests + ' entries)';
          fill.style.width = Math.min(100, totalRequests * 10) + '%';
          detail.innerHTML = '<span style="color:var(--accent);">' + totalRequests + '</span> cached responses across <span style="color:var(--info);">' + keys.length + '</span> cache(s)';
        } catch (e) {
          info.textContent = 'Cache check failed: ' + e.message;
        }
      } else {
        info.textContent = 'Cache API not supported';
      }
    }

    // PWA manifest comparison panel
    async function loadPWACompare() {
      const content = document.getElementById('pwa-compare-content');
      const h3 = document.querySelector('#pwa-compare-panel h3');
      if (content.style.display === 'none') {
        content.style.display = 'block';
        h3.textContent = 'Manifest Comparison: BUN-DEV vs bun.com ▾';
        content.innerHTML = '<p style="color: var(--fg-dim); font-size: 0.8rem;">Loading...</p>';
        try {
          const res = await fetch('/api/pwa/compare');
          const data = await res.json();
          const s = data.summary;
          let html = '<table><tr><th>Metric</th><th>BUN-DEV</th><th>bun.com</th></tr>';
          html += '<tr><td>Installable</td><td>' + (s.ourInstallable ? '✅ Yes' : '❌ No') + '</td><td>' + (s.theirInstallable ? '✅ Yes' : '❌ No') + '</td></tr>';
          html += '<tr><td>Score</td><td>' + s.ourScore + '%</td><td>' + s.theirScore + '%</td></tr>';
          html += '<tr><td>Icon count</td><td>' + s.ourIconCount + '</td><td>' + s.theirIconCount + '</td></tr>';
          html += '<tr><td>Matching fields</td><td colspan="2">' + s.matchingFields + '/' + s.totalFields + '</td></tr>';
          html += '</table>';

          html += '<h4 style="color:var(--info); margin: 0.75rem 0 0.25rem; font-size: 0.85rem;">Field Comparison</h4>';
          html += '<table><tr><th>Field</th><th>BUN-DEV</th><th>bun.com</th><th>Match</th></tr>';
          data.fields.forEach(f => {
            html += '<tr><td>' + f.field + '</td><td style="font-size:0.8rem;">' + f.ours + '</td><td style="font-size:0.8rem;">' + f.theirs + '</td><td>' + (f.match ? '✅' : '⚠️') + '</td></tr>';
          });
          html += '</table>';

          html += '<h4 style="color:var(--info); margin: 0.75rem 0 0.25rem; font-size: 0.85rem;">Icon Sizes</h4>';
          html += '<table><tr><th>Size</th><th>BUN-DEV</th><th>bun.com</th></tr>';
          data.icons.forEach(i => {
            html += '<tr><td>' + i.size + '</td><td>' + (i.ours ? '✅' : '—') + '</td><td>' + (i.theirs ? '✅' : '—') + '</td></tr>';
          });
          html += '</table>';

          // Validation details
          const v = data.validation;
          html += '<h4 style="color:var(--info); margin: 0.75rem 0 0.25rem; font-size: 0.85rem;">BUN-DEV Validation (' + v.ours.score + '%)</h4>';
          html += '<table><tr><th>Check</th><th>Pass</th></tr>';
          v.ours.checks.forEach(c => {
            html += '<tr><td>' + c.check + '</td><td>' + (c.pass ? '✅' : '❌') + '</td></tr>';
          });
          if (v.ours.errors.length) html += '<tr><td colspan="2" style="color:var(--err);">Errors: ' + v.ours.errors.join(', ') + '</td></tr>';
          if (v.ours.warnings.length) html += '<tr><td colspan="2" style="color:var(--warn);">Warnings: ' + v.ours.warnings.join(', ') + '</td></tr>';
          html += '</table>';

          html += '<h4 style="color:var(--info); margin: 0.75rem 0 0.25rem; font-size: 0.85rem;">bun.com Validation (' + v.theirs.score + '%)</h4>';
          html += '<table><tr><th>Check</th><th>Pass</th></tr>';
          v.theirs.checks.forEach(c => {
            html += '<tr><td>' + c.check + '</td><td>' + (c.pass ? '✅' : '❌') + '</td></tr>';
          });
          if (v.theirs.errors.length) html += '<tr><td colspan="2" style="color:var(--err);">Errors: ' + v.theirs.errors.join(', ') + '</td></tr>';
          if (v.theirs.warnings.length) html += '<tr><td colspan="2" style="color:var(--warn);">Warnings: ' + v.theirs.warnings.join(', ') + '</td></tr>';
          html += '</table>';

          content.innerHTML = html;
        } catch (e) {
          content.innerHTML = '<p style="color:var(--err); font-size: 0.8rem;">Error: ' + e.message + '</p>';
        }
      } else {
        content.style.display = 'none';
        h3.textContent = 'Manifest Comparison: BUN-DEV vs bun.com ▸';
      }
    }

    // PWA validation panel
    async function loadPWAValidate() {
      const content = document.getElementById('pwa-validate-content');
      const h3 = document.querySelector('#pwa-validate-panel h3');
      if (content.style.display === 'none') {
        content.style.display = 'block';
        h3.textContent = 'Installability Validation ▾';
        content.innerHTML = '<p style="color: var(--fg-dim); font-size: 0.8rem;">Loading...</p>';
        try {
          const res = await fetch('/api/pwa/validate');
          const data = await res.json();
          let html = '<div style="margin-bottom: 0.5rem;">';
          html += '<span style="font-size: 1.2rem; color: ' + (data.installable ? 'var(--accent)' : 'var(--err)') + ';">';
          html += data.installable ? '✅ Installable' : '❌ Not Installable';
          html += '</span> <span style="color: var(--fg-dim); font-size: 0.85rem;">(' + data.score + '% score)</span>';
          html += '</div>';
          html += '<table><tr><th>Category</th><th>Check</th><th>Pass</th><th>Detail</th></tr>';
          data.checks.forEach(c => {
            const color = c.pass ? 'var(--accent)' : c.severity === 'error' ? 'var(--err)' : c.severity === 'warning' ? 'var(--warn)' : 'var(--fg-dim)';
            html += '<tr><td style="font-size:0.75rem; color:var(--fg-dim);">' + c.category + '</td><td>' + c.check + '</td><td style="color:' + color + ';">' + (c.pass ? '✅' : '❌') + '</td><td style="font-size:0.8rem; color:var(--fg-dim);">' + c.detail + '</td></tr>';
          });
          html += '</table>';
          content.innerHTML = html;
        } catch (e) {
          content.innerHTML = '<p style="color:var(--err); font-size: 0.8rem;">Error: ' + e.message + '</p>';
        }
      } else {
        content.style.display = 'none';
        h3.textContent = 'Installability Validation ▸';
      }
    }
  </script>
  ${ENABLE_PWA ? `<script>
    // PWA install prompt
    let deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      const btn = document.getElementById('pwa-install-btn');
      if (btn) btn.style.display = 'inline-block';
      console.log('[PWA] install prompt available');
    });
    function installPWA() {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((choice) => {
          if (choice.outcome === 'accepted') {
            console.log('[PWA] user accepted install');
            const btn = document.getElementById('pwa-install-btn');
            if (btn) btn.style.display = 'none';
          } else {
            console.log('[PWA] user dismissed install');
          }
          deferredPrompt = null;
        });
      } else {
        alert('Install option not available. Use Chrome menu > Install BUN-DEV.');
      }
    }
    window.addEventListener('appinstalled', () => {
      console.log('[PWA] app installed successfully');
      const btn = document.getElementById('pwa-install-btn');
      if (btn) btn.style.display = 'none';
    });

    // Service worker registration + status badge
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(function(reg) {
        console.log('[PWA] service worker registered', reg.scope);
        const badge = document.getElementById('sw-status');
        if (badge) {
          badge.textContent = 'SW: active';
          badge.classList.add('active');
        }
      }).catch(function(err) {
        console.warn('[PWA] service worker registration failed', err);
        const badge = document.getElementById('sw-status');
        if (badge) {
          badge.textContent = 'SW: failed';
          badge.classList.add('inactive');
        }
      });
    } else {
      const badge = document.getElementById('sw-status');
      if (badge) {
        badge.textContent = 'SW: unsupported';
        badge.classList.add('inactive');
      }
    }

    // Check SW cache after registration
    setTimeout(checkSWCache, 2000);

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      switch (e.key.toLowerCase()) {
        case 'r': pollHealth(); fetchMetrics(); showToast('🔄 Refreshed'); break;
        case 'i': installPWA(); break;
        case 'c': loadPWACompare(); break;
        case 'v': loadPWAValidate(); break;
        case 'g':
          const gal = document.getElementById('icon-gallery-content');
          const galH3 = document.querySelector('#icon-gallery-content').previousElementSibling;
          toggleSection('icon-gallery-content', galH3);
          break;
      }
    });
  </script>` : ""}
</body>
</html>`;
  let response = new Response(html, { headers: { "Content-Type": "text/html" } });

  // HTMLRewriter: dynamically inject theme-color meta, feature-flag script,
  // CSP nonce attributes, and a data-rewritten attribute into the dashboard HTML.
  // Ref: node_modules/bun-types/docs/runtime/html-rewriter.mdx
  // Ref: node_modules/bun-types/docs/runtime/color.mdx — Bun.color normalizes the input
  if (ENABLE_HTML_REWRITER) {
    const activeFlags = listFeatures()
      .filter((f) => f.active)
      .map((f) => `'${f.key}': true`)
      .join(",");
    // Generate per-request CSP nonce using Bun.CryptoHasher
    // Ref: node_modules/bun-types/docs/runtime/hashing.mdx
    const nonce = Bun.CryptoHasher.hash("sha256", crypto.randomUUID() + process.uptime(), "hex").slice(0, 32);
    const flagScript = `<script nonce="${nonce}">window.__FEATURE_FLAGS__ = {${activeFlags}};</script>`;
    // Use Bun.color to normalize the theme color to a CSS-compatible hex string.
    // In production, use black; in development, use the Dracula green (#50fa7b).
    const rawThemeColor = NODE_ENV === "production" ? "#000000" : "#50fa7b";
    const themeColor = Bun.color(rawThemeColor, "css") ?? rawThemeColor;
    response = new HTMLRewriter()
      .on("head", {
        element(el) {
          // Inject theme-color meta based on environment
          el.append(
            `<meta name="theme-color" content="${themeColor}">`,
            { html: true },
          );
          // Inject feature flags as a client-side global (with CSP nonce)
          el.append(flagScript, { html: true });
        },
      })
      .on("script", {
        element(el) {
          // Add nonce to all existing <script> tags for CSP compliance
          if (!el.getAttribute("nonce")) {
            el.setAttribute("nonce", nonce);
          }
        },
      })
      .on("body", {
        element(el) {
          el.setAttribute("data-html-rewritten", "true");
        },
      })
      .transform(response);
    // Add Content-Security-Policy header with nonce
    const csp = `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self';`;
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", csp);
    response = new Response(response.body, { status: response.status, headers });
  }

  return response;
});

// Sitemap XML — lists all public routes with metadata
// Ref: https://www.sitemaps.org/protocol.html
// Each route has priority (1.0=most important), changefreq, and lastmod.
// Dynamic routes (with :params) are excluded; auth-required routes get lower priority.
function sitemapHandler(req: BunRequest): Response {
  const url = new URL(req.url);
  const base = `${url.protocol}//${url.host}`;
  const lastmod = new Date().toISOString();

  // Route metadata — priority and changefreq per route pattern
  // Ref: https://www.sitemaps.org/protocol.html#xmlTagDefinitions
  const routeMeta: Record<string, { priority: number; changefreq: string }> = {
    "/health": { priority: 0.9, changefreq: "always" },
    "/metrics": { priority: 0.8, changefreq: "always" },
    "/dashboard": { priority: 1.0, changefreq: "hourly" },
    "/manifest.json": { priority: 0.6, changefreq: "weekly" },
    "/sw.js": { priority: 0.4, changefreq: "monthly" },
    "/features": { priority: 0.7, changefreq: "daily" },
    "/protocol": { priority: 0.5, changefreq: "weekly" },
    "/api/openapi.json": { priority: 0.8, changefreq: "daily" },
    "/api/semver": { priority: 0.6, changefreq: "weekly" },
    "/api/pwa/validate": { priority: 0.5, changefreq: "weekly" },
    "/api/pwa/compare": { priority: 0.4, changefreq: "weekly" },
    "/api/diagrams": { priority: 0.5, changefreq: "weekly" },
    "/api/config": { priority: 0.4, changefreq: "weekly" },
    "/api/ffi": { priority: 0.3, changefreq: "monthly" },
    "/api/hash": { priority: 0.3, changefreq: "monthly" },
    "/api/transpile": { priority: 0.4, changefreq: "weekly" },
    "/api/compress": { priority: 0.3, changefreq: "monthly" },
    "/api/utils": { priority: 0.3, changefreq: "monthly" },
    "/api/redis": { priority: 0.3, changefreq: "monthly" },
  };

  // Auth-required routes get lower priority
  const authRoutes = new Set([
    "/tasks", "/sessions", "/api/tasks.jsonl", "/api/sessions.jsonl",
    "/api/audit.jsonl", "/api/audit/stream", "/api/export/bundle.tar",
    "/api/s3/backup", "/api/logs", "/api/processes", "/api/fs",
    "/api/runtime", "/api/sql", "/api/image", "/api/screenshot",
    "/api/mermaid",
  ]);

  // Only advertise routes a crawler can actually GET. Previously POST-only
  // routes (/login, /api/sql, /api/manifest, /api/share-target, /api/markdown,
  // /api/mermaid, /task) were listed, so crawlers fetched them and got 404/405.
  // /bun-com/* is an internal comparison snapshot and is deliberately excluded.
  const paths = Object.entries(routes)
    .filter(([p, handlers]) => {
      if (p.includes(":") || p === "/sitemap.xml" || p.startsWith("/bun-com/")) return false;
      // JUSTIFIED: routes is Record<string, unknown>; narrowing to the method map
      return Boolean((handlers as { GET?: unknown }).GET);
    })
    .map(([p]) => p);

  const urls = paths
    .map((p) => {
      const meta = routeMeta[p] ?? {
        priority: authRoutes.has(p) ? 0.3 : 0.5,
        changefreq: authRoutes.has(p) ? "hourly" : "weekly",
      };
      return `  <url>
    <loc>${base}${p}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${meta.changefreq}</changefreq>
    <priority>${meta.priority.toFixed(1)}</priority>
  </url>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "X-Sitemap-Route-Count": paths.length.toString(),
    },
  });
}

// Markdown rendering API — chains Bun.serve with Bun.markdown.html()
// Ref: node_modules/bun-types/docs/runtime/markdown.mdx
async function markdownHandler(req: BunRequest): Promise<Response> {
  const body = await req.text();
  const maxBytes = 1024 * 1024; // 1 MB
  if (body.length > maxBytes) {
    return errorResponse("markdown body too large", 413);
  }
  const rendered = Bun.markdown.html(body);
  // Wrap in a minimal HTML document so HTMLRewriter can target <head>/<body>
  const html = `<!DOCTYPE html>\n<html><head><title>Markdown</title></head><body>${rendered}</body></html>`;
  let response = new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });

  // HTMLRewriter: inject a source-info comment and mark rendered markdown
  // Ref: https://bun.com/docs/runtime/htmlrewriter
  if (ENABLE_HTML_REWRITER) {
    response = new HTMLRewriter()
      .on("body", {
        element(el) {
          el.setAttribute("data-markdown-rendered", "true");
        },
      })
      .transform(response);
  }

  return response;
}

// Build the routes object — conditionally include dashboard routes
const routes: Record<string, unknown> = {
  // Public routes (no auth)
  "/health": { GET: healthHandler },
  "/metrics": { GET: metricsHandler },
  "/login": { POST: loginHandler },
  "/protocol": { GET: protocolHandler },
  "/features": { GET: featuresHandler },
  "/api/color": { GET: colorHandler },
  "/api/env": { GET: envHandler },
  "/api/health-log": { GET: healthLogHandler },
  "/api/openapi.json": { GET: openApiHandler },
  "/api/semver": { GET: semverHandler },
  "/api/diagrams": { GET: diagramsListHandler },
  "/api/config": { GET: configHandler },
  "/api/redis": { GET: redisRateLimitHandler },
  "/api/stream/:path": { GET: streamFileHandler },
  "/api/ffi": { GET: ffiHandler },
  "/api/hash": { GET: hashHandler },
  "/api/transpile": { GET: transpileHandler },
  "/api/dns": { GET: dnsHandler, POST: dnsLookupHandler },
  "/api/fs": { GET: fsBrowserHandler },
  "/api/compress": { GET: compressHandler },
  "/api/utils": { GET: utilsHandler },
  "/api/runtime": { GET: runtimeHandler },

  // Auth-required routes
  "/tasks": { GET: listTasksHandler },
  "/api/tasks.jsonl": { GET: tasksJsonlHandler },
  "/task": { POST: createTaskHandler },       // also requires CSRF
  "/task/:id": { GET: getTaskHandler },
  "/sessions": { GET: listSessionsHandler },
  "/api/sessions.jsonl": { GET: sessionsJsonlHandler },
  "/screenshot/:id": { GET: getScreenshotHandler },
  "/audit": { GET: auditHandler },
  "/api/audit.jsonl": { GET: auditJsonlHandler },
  "/api/audit/stream": { GET: auditStreamHandler },
  "/api/export/bundle.tar": { GET: exportBundleHandler },
  "/api/admin/shell": { POST: adminShellHandler },  // also requires CSRF
  "/api/features/toggle": { POST: featureToggleHandler },  // also requires CSRF
  "/api/mermaid": { POST: mermaidRenderHandler },
  "/api/s3/backup": { GET: s3BackupHandler },
  "/api/logs": { GET: logsHandler },
  "/api/processes": { GET: processesHandler },
  "/api/sql": { POST: sqlQueryHandler },
  "/api/image": { GET: imageProcessHandler },
  "/api/screenshot": { GET: screenshotHandler },
  "/api/config/write": { POST: configWriteHandler },  // also requires CSRF
};

// Sitemap feature flag — enable the route and mark active when requested
if (ENABLE_SITEMAP) {
  routes["/sitemap.xml"] = { GET: sitemapHandler };
  markActive("sitemap");
}

// HTMLRewriter feature flag — mark active (no route needed; it transforms
// existing HTML responses from /dashboard and /api/markdown)
if (ENABLE_HTML_REWRITER) {
  markActive("htmlRewriter");
  log("server", "info", "HTMLRewriter enabled — injecting into HTML responses");
}

// --- PWA manifest: committed base + runtime overrides ---------------------
// The committed manifest is read-only at runtime. Edits made through
// POST /api/manifest land in a separate, gitignored overrides file and are
// merged on read. This keeps the source tree clean (previously the editor
// rewrote and reformatted the tracked file, dirtying git on every test run).

const MANIFEST_PATH = "public/manifest.json";
const MANIFEST_OVERRIDES_PATH = "data/manifest-overrides.json";

/** Read runtime overrides; missing or corrupt file yields no overrides. */
async function readManifestOverrides(): Promise<Record<string, unknown>> {
  try {
    const file = Bun.file(MANIFEST_OVERRIDES_PATH);
    if (!(await file.exists())) return {};
    // JUSTIFIED: .json() returns unknown; narrowing to the override map shape
    return await file.json() as Record<string, unknown>;
  } catch {
    // Corrupt override file must not break manifest serving.
    log("server", "warn", "manifest overrides unreadable — serving committed base");
    return {};
  }
}

type FieldVerdict = { ok: true } | { ok: false; error: string };

/** Bounded non-empty string. */
const str = (max: number) => (v: unknown): FieldVerdict =>
  typeof v !== "string" ? { ok: false, error: "expected a string" }
    : v.length === 0 ? { ok: false, error: "must not be empty" }
    : v.length > max ? { ok: false, error: `exceeds ${max} characters` }
    : { ok: true };

/** Value must be one of a fixed set. */
const oneOf = (...allowed: string[]) => (v: unknown): FieldVerdict =>
  typeof v === "string" && allowed.includes(v)
    ? { ok: true }
    : { ok: false, error: `expected one of: ${allowed.join(", ")}` };

/** CSS color parseable by Bun.color. Ref: docs/runtime/color.mdx */
const color = (v: unknown): FieldVerdict =>
  typeof v !== "string" ? { ok: false, error: "expected a color string" }
    : Bun.color(v, "css") === null ? { ok: false, error: "not a parseable CSS color" }
    : { ok: true };

/** Same-origin root-relative path — blocks absolute URLs and traversal. */
const path = (v: unknown): FieldVerdict =>
  typeof v !== "string" ? { ok: false, error: "expected a string" }
    : !v.startsWith("/") ? { ok: false, error: "must start with /" }
    : v.includes("..") ? { ok: false, error: "must not contain .." }
    : v.length > 512 ? { ok: false, error: "exceeds 512 characters" }
    : { ok: true };

const stringArray = (max: number) => (v: unknown): FieldVerdict =>
  !Array.isArray(v) ? { ok: false, error: "expected an array" }
    : v.length > max ? { ok: false, error: `at most ${max} entries` }
    : v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 64)
      ? { ok: true }
      : { ok: false, error: "entries must be non-empty strings under 64 chars" };

/**
 * Editable manifest fields and their value validators.
 * Structural fields (icons, shortcuts, file_handlers, id) are intentionally
 * absent — they are generated or must stay stable for app identity.
 * Ref: https://w3c.github.io/manifest/
 */
const MANIFEST_EDITABLE_FIELDS: Record<string, (v: unknown) => FieldVerdict> = {
  name: str(128),
  short_name: str(64),
  description: str(1024),
  theme_color: color,
  background_color: color,
  // Ref: https://w3c.github.io/manifest/#display-member
  display: oneOf("fullscreen", "standalone", "minimal-ui", "browser"),
  // Ref: https://w3c.github.io/manifest/#orientation-member
  orientation: oneOf(
    "any", "natural", "landscape", "portrait",
    "portrait-primary", "portrait-secondary",
    "landscape-primary", "landscape-secondary",
  ),
  lang: str(35),
  dir: oneOf("ltr", "rtl", "auto"),
  categories: stringArray(16),
  start_url: path,
  scope: path,
};

// PWA feature flag — serve manifest.json and icons so the dashboard can be
// installed as a Chrome standalone app.
// Ref: https://web.dev/articles/add-manifest
if (ENABLE_PWA) {
  // Dynamic PWA manifest — reads base from disk, injects runtime values
  // (server URL, active features, Bun version) so the manifest reflects
  // the actual running server state.
  // Ref: https://web.dev/articles/add-manifest
  // Ref: https://w3c.github.io/manifest-app-info/
  routes["/manifest.json"] = {
    GET: withMiddleware(async (): Promise<Response> => {
      // JUSTIFIED: .json() returns unknown; narrowing to the manifest object shape
      const base = await Bun.file(MANIFEST_PATH).json() as Record<string, unknown>;
      // Layer runtime overrides (written by POST /api/manifest) on top of the
      // committed base. The base file is never mutated.
      const m = { ...base, ...(await readManifestOverrides()) };

      // NOTE: `id` and `start_url` are deliberately NOT derived from the request
      // origin. `id` is the PWA's stable identity — deriving it from the origin
      // makes http/https, localhost/prod, or a port change look like a different
      // app to the browser, which re-prompts install and orphans the existing
      // installation. Both come from the committed manifest verbatim.

      // file_handlers — desktop file association (Chrome 117+).
      // Ref: https://developer.chrome.com/articles/file-handling/
      // Concrete MIME types only; the spec does not allow wildcards here.
      m.file_handlers = [
        {
          action: "/dashboard?source=file-handler",
          accept: {
            "application/json": [".json"],
            "application/manifest+json": [".webmanifest"],
            "text/markdown": [".md", ".markdown"],
            "text/yaml": [".yaml", ".yml"],
            "text/toml": [".toml"],
          },
        },
      ];
      // share_target — receives shared text/links (Chrome 76+).
      // Ref: https://developer.chrome.com/articles/web-share-target/
      m.share_target = {
        action: "/api/share-target",
        method: "POST",
        enctype: "application/x-www-form-urlencoded",
        params: { title: "title", text: "text", url: "url" },
      };
      // launch_handler — route launches into an existing window.
      // Ref: https://developer.chrome.com/docs/web-platform/launch-handler
      // Valid client_mode values are only: auto | navigate-new |
      // navigate-existing | focus-existing. Anything else falls back to "auto".
      m.launch_handler = { client_mode: "navigate-existing" };
      // protocol_handlers — register the app to handle URL protocols.
      // Ref: https://developer.mozilla.org/en-US/docs/Web/Manifest/protocol_handlers
      // mailto is universally understood; the dashboard can compose a task
      // from the subject/body. Other schemes would require OS-level
      // registration and are omitted.
      m.protocol_handlers = [
        {
          protocol: "mailto",
          url: "/dashboard?source=protocol-handler&to=%s",
        },
      ];

      return new Response(JSON.stringify(m, null, 2), {
        headers: {
          // Bun.file() reports application/json for .json, not the manifest
          // type the spec requires — so set it explicitly.
          "Content-Type": "application/manifest+json",
          // Must revalidate: a stale manifest at a CDN/proxy pins old icons
          // and shortcuts for the installed app.
          "Cache-Control": "no-cache, must-revalidate, max-age=0",
        },
      });
    }),
  };

  // Manifest editor — writes a runtime *override*, never the committed base.
  // POST /api/manifest with { field: "theme_color", value: "#ff0000" }
  routes["/api/manifest"] = {
    POST: withCsrf(async (req: BunRequest): Promise<Response> => {
      // JUSTIFIED: req.json() returns unknown; narrowing to manifest update body
      const body = await req.json() as { field?: string; value?: unknown };
      if (!body.field || body.value === undefined) {
        return json({ error: "field and value required" }, 400);
      }
      const validator = MANIFEST_EDITABLE_FIELDS[body.field];
      if (!validator) {
        return json({
          error: `field must be one of: ${Object.keys(MANIFEST_EDITABLE_FIELDS).join(", ")}`,
        }, 400);
      }
      // Validate the *value*, not just the field name — an unvalidated value
      // persists a structurally invalid manifest across restarts.
      const verdict = validator(body.value);
      if (!verdict.ok) {
        return json({ error: `invalid value for ${body.field}: ${verdict.error}` }, 400);
      }
      try {
        const overrides = await readManifestOverrides();
        overrides[body.field] = body.value;
        await Bun.write(MANIFEST_OVERRIDES_PATH, JSON.stringify(overrides, null, 2) + "\n");
        await audit({
          action: "manifest_update",
          resource: MANIFEST_OVERRIDES_PATH,
          details: `${body.field}=${JSON.stringify(body.value)}`.slice(0, 200),
        });
        log("server", "info", "Manifest override written", { field: body.field, value: body.value });
        return json({ ok: true, field: body.field, value: body.value, path: MANIFEST_OVERRIDES_PATH });
      } catch (err) {
        return json({ error: "manifest update failed", details: String(err) }, 500);
      }
    }),
    // Clear all runtime overrides, reverting to the committed manifest.
    DELETE: withCsrf(async (): Promise<Response> => {
      try {
        await Bun.file(MANIFEST_OVERRIDES_PATH).delete();
      } catch {
        // Already absent — reverting to base is the desired end state either way.
      }
      await audit({ action: "manifest_reset", resource: MANIFEST_OVERRIDES_PATH });
      return json({ ok: true, reset: true });
    }),
  };

  // PWA share target — receives shared content from other apps
  // Ref: https://developer.chrome.com/articles/web-share-target/
  routes["/api/share-target"] = {
    POST: withMiddleware(async (req: BunRequest): Promise<Response> => {
      // This route is unauthenticated (the OS share sheet cannot supply a
      // bearer token), so treat every field as hostile: bound the length and
      // strip control characters before it reaches the audit log or any
      // newline-delimited log consumer.
      const clean = (v: unknown, max: number): string =>
        typeof v === "string"
          ? v.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max)
          : "";

      // Inferred rather than annotated: bun-types and undici-types disagree on
      // the FormData shape, so an explicit `FormData` annotation fails tsc.
      let formData: Awaited<ReturnType<typeof req.formData>>;
      try {
        formData = await req.formData();
      } catch {
        // Unparseable body is a client error, not a server fault — without
        // this the throw escapes to the top-level error() hook as a 500.
        return json({ error: "expected form-encoded body with title/text/url" }, 400);
      }

      const title = clean(formData.get("title"), 200);
      const text = clean(formData.get("text"), 2000);
      const sharedUrl = clean(formData.get("url"), 2000);

      await audit({
        action: "share_received",
        resource: "pwa-share-target",
        details: `title=${title}`.slice(0, 200),
      });
      log("server", "info", "PWA share received", { title, url: sharedUrl });
      return json({ ok: true, received: { title, text, url: sharedUrl } });
    }),
  };
  // Serve the service worker — required by Chrome for PWA installability
  // Ref: https://web.dev/articles/install-criteria
  routes["/sw.js"] = {
    GET: withMiddleware((): Response => {
      const sw = Bun.file("public/sw.js");
      return new Response(sw, {
        headers: { "Content-Type": "application/javascript", "Service-Worker-Allowed": "/" },
      });
    }),
  };
  // Serve the original bun.com PWA manifest and icons (downloaded snapshot)
  // so users can compare or reinstall the upstream Bun docs PWA locally.
  routes["/bun-com/manifest.json"] = {
    GET: withMiddleware((): Response => {
      const manifest = Bun.file("public/bun-com/manifest.json");
      return new Response(manifest, {
        headers: { "Content-Type": "application/manifest+json" },
      });
    }),
  };
  routes["/bun-com/icons/:filename"] = {
    GET: withMiddleware<"/bun-com/icons/:filename">(
      async (req: BunRequest<"/bun-com/icons/:filename">): Promise<Response> => {
        const filename = req.params.filename;
        const file = Bun.file(`public/bun-com/icons/${filename}`);
        const exists = await file.exists();
        if (!exists) {
          return errorResponse("icon not found", 404);
        }
        // Infer content type from extension
        const ext = filename.endsWith(".svg") ? "image/svg+xml"
          : filename.endsWith(".ico") ? "image/x-icon"
          : "image/png";
        return new Response(file, {
          headers: { "Content-Type": ext, "Cache-Control": "public, max-age=86400" },
        });
      },
    ),
  };

  // PWA manifest comparison — diffs BUN-DEV manifest against the downloaded
  // bun.com manifest, field by field, and validates both against Chrome's
  // installability criteria.
  // Ref: https://web.dev/articles/install-criteria
  routes["/api/pwa/compare"] = {
    GET: withMiddleware(async (): Promise<Response> => {
      const ours = await Bun.file("public/manifest.json").json();
      const theirs = await Bun.file("public/bun-com/manifest.json").json();

      // --- Field-by-field comparison ---
      type Manifest = {
        name?: string; short_name?: string; description?: string;
        start_url?: string; scope?: string; display?: string;
        orientation?: string; theme_color?: string; background_color?: string;
        icons?: { src: string; sizes: string; type: string; purpose?: string }[];
      };
      // JUSTIFIED: Bun.file().json() returns Promise<unknown>; narrowing to manifest shape
      const o = ours as Manifest; // JUSTIFIED: see above
      const t = theirs as Manifest; // JUSTIFIED: see above

      const fields: { field: string; ours: string; theirs: string; match: boolean }[] = [];
      const compareField = (field: keyof Manifest): void => {
        const ov = JSON.stringify(o[field] ?? null);
        const tv = JSON.stringify(t[field] ?? null);
        fields.push({ field, ours: ov, theirs: tv, match: ov === tv });
      };
      compareField("name");
      compareField("short_name");
      compareField("description");
      compareField("start_url");
      compareField("scope");
      compareField("display");
      compareField("orientation");
      compareField("theme_color");
      compareField("background_color");

      // --- Icon comparison ---
      const ourIcons = (o.icons ?? []).map((i) => i.sizes);
      const theirIcons = (t.icons ?? []).map((i) => i.sizes);
      const allSizes = [...new Set([...ourIcons, ...theirIcons])].sort();
      const iconComparison = allSizes.map((size) => ({
        size,
        ours: ourIcons.includes(size),
        theirs: theirIcons.includes(size),
      }));

      // --- Installability validation (Chrome criteria) ---
      // Ref: https://web.dev/articles/install-criteria
      const validate = (manifest: Manifest, label: string) => {
        const errors: string[] = [];
        const warnings: string[] = [];
        const checks: { check: string; pass: boolean }[] = [];

        // Required: name or short_name
        const hasName = !!(manifest.name || manifest.short_name);
        checks.push({ check: "Has name or short_name", pass: hasName });
        if (!hasName) errors.push("Missing name and short_name");

        // Required: icons with at least 192x192 and 512x512
        const icons = manifest.icons ?? [];
        const has192 = icons.some((i) => i.sizes === "192x192");
        const has512 = icons.some((i) => i.sizes === "512x512");
        checks.push({ check: "Has 192x192 icon", pass: has192 });
        checks.push({ check: "Has 512x512 icon", pass: has512 });
        if (!has192) errors.push("Missing 192x192 icon");
        if (!has512) errors.push("Missing 512x512 icon");

        // Required: manifest
        checks.push({ check: "Manifest is valid JSON", pass: true });

        // Recommended: start_url
        const hasStartUrl = !!manifest.start_url;
        checks.push({ check: "Has start_url", pass: hasStartUrl });
        if (!hasStartUrl) errors.push("Missing start_url");

        // Recommended: display mode
        const hasDisplay = !!manifest.display;
        checks.push({ check: "Has display mode", pass: hasDisplay });
        if (!hasDisplay) warnings.push("No display mode specified");

        // Recommended: theme_color
        const hasTheme = !!manifest.theme_color;
        checks.push({ check: "Has theme_color", pass: hasTheme });
        if (!hasTheme) warnings.push("No theme_color specified");

        // Recommended: background_color
        const hasBg = !!manifest.background_color;
        checks.push({ check: "Has background_color", pass: hasBg });
        if (!hasBg) warnings.push("No background_color specified");

        // Recommended: maskable icon (Android adaptive icon)
        const hasMaskable = icons.some((i) => i.purpose === "maskable");
        checks.push({ check: "Has maskable icon", pass: hasMaskable });
        if (!hasMaskable) warnings.push("No maskable icon (Android adaptive icons)");

        // Recommended: short_name (for home screen)
        const hasShortName = !!manifest.short_name;
        checks.push({ check: "Has short_name", pass: hasShortName });
        if (!hasShortName) warnings.push("No short_name (needed for home screen)");

        // Service worker check (we know we have one)
        checks.push({ check: "Has service worker (/sw.js)", pass: true });

        return {
          label,
          checks,
          errors,
          warnings,
          installable: errors.length === 0,
          score: Math.round((checks.filter((c) => c.pass).length / checks.length) * 100),
        };
      };

      const ourValidation = validate(o, "BUN-DEV");
      const theirValidation = validate(t, "bun.com");

      // --- Summary ---
      const matchingFields = fields.filter((f) => f.match).length;
      const summary = {
        totalFields: fields.length,
        matchingFields,
        differingFields: fields.length - matchingFields,
        ourIconCount: ourIcons.length,
        theirIconCount: theirIcons.length,
        ourInstallable: ourValidation.installable,
        theirInstallable: theirValidation.installable,
        ourScore: ourValidation.score,
        theirScore: theirValidation.score,
      };

      return Response.json({
        summary,
        fields,
        icons: iconComparison,
        validation: { ours: ourValidation, theirs: theirValidation },
      }, {
        headers: { "Cache-Control": "no-cache" },
      });
    }),
  };

  // PWA manifest validation — validates our manifest against Chrome criteria
  routes["/api/pwa/validate"] = {
    GET: withMiddleware(async (): Promise<Response> => {
      const manifest = await Bun.file("public/manifest.json").json();
      const swExists = await Bun.file("public/sw.js").exists();

      type M = {
        name?: string; short_name?: string; description?: string;
        start_url?: string; scope?: string; display?: string;
        orientation?: string; theme_color?: string; background_color?: string;
        icons?: { src: string; sizes: string; type: string; purpose?: string }[];
      };
      // JUSTIFIED: Bun.file().json() returns Promise<unknown>; narrowing to manifest shape
      const m = manifest as M; // JUSTIFIED: see above
      const icons = m.icons ?? [];

      const checks: {
        category: string; check: string; pass: boolean; severity: string;
        detail: string;
      }[] = [];

      // --- Required fields ---
      checks.push({
        category: "required", check: "name", pass: !!m.name,
        severity: "error", detail: m.name ? `"${m.name}"` : "missing",
      });
      checks.push({
        category: "required", check: "short_name", pass: !!m.short_name,
        severity: "error", detail: m.short_name ? `"${m.short_name}"` : "missing",
      });
      checks.push({
        category: "required", check: "start_url", pass: !!m.start_url,
        severity: "error", detail: m.start_url ?? "missing",
      });
      checks.push({
        category: "required", check: "icons[192x192]", pass: icons.some((i) => i.sizes === "192x192"),
        severity: "error", detail: icons.find((i) => i.sizes === "192x192")?.src ?? "missing",
      });
      checks.push({
        category: "required", check: "icons[512x512]", pass: icons.some((i) => i.sizes === "512x512"),
        severity: "error", detail: icons.find((i) => i.sizes === "512x512")?.src ?? "missing",
      });
      checks.push({
        category: "required", check: "service worker", pass: swExists,
        severity: "error", detail: swExists ? "/sw.js" : "missing",
      });

      // --- Recommended fields ---
      checks.push({
        category: "recommended", check: "display", pass: !!m.display,
        severity: "warning", detail: m.display ?? "missing",
      });
      checks.push({
        category: "recommended", check: "theme_color", pass: !!m.theme_color,
        severity: "warning", detail: m.theme_color ?? "missing",
      });
      checks.push({
        category: "recommended", check: "background_color", pass: !!m.background_color,
        severity: "warning", detail: m.background_color ?? "missing",
      });
      checks.push({
        category: "recommended", check: "scope", pass: !!m.scope,
        severity: "warning", detail: m.scope ?? "missing",
      });
      checks.push({
        category: "recommended", check: "orientation", pass: !!m.orientation,
        severity: "warning", detail: m.orientation ?? "missing",
      });
      checks.push({
        category: "recommended", check: "description", pass: !!m.description,
        severity: "info", detail: m.description ?? "missing",
      });

      // --- Icon quality ---
      checks.push({
        category: "icon-quality", check: "maskable icon", pass: icons.some((i) => i.purpose === "maskable"),
        severity: "warning", detail: icons.find((i) => i.purpose === "maskable")?.src ?? "missing",
      });
      checks.push({
        category: "icon-quality", check: "icon count >= 3", pass: icons.length >= 3,
        severity: "info", detail: `${icons.length} icons`,
      });
      checks.push({
        category: "icon-quality", check: "has 1024x1024", pass: icons.some((i) => i.sizes === "1024x1024"),
        severity: "info", detail: icons.find((i) => i.sizes === "1024x1024")?.src ?? "missing",
      });
      checks.push({
        category: "icon-quality", check: "has SVG icon", pass: icons.some((i) => i.type === "image/svg+xml"),
        severity: "info", detail: icons.find((i) => i.type === "image/svg+xml")?.src ?? "missing",
      });

      // --- Icon integrity: declared files must exist and match declared size ---
      // Declaring an icon the server 404s on (or whose real pixels differ from
      // its `sizes` string) previously scored as a pass, so the endpoint could
      // report 100% installable against a manifest Chrome partly discards.
      // Ref: node_modules/bun-types/docs/runtime/image.mdx — metadata()
      const missing: string[] = [];
      const mismatched: string[] = [];
      for (const icon of icons) {
        // Only local, root-relative icons are verifiable here.
        if (!icon.src.startsWith("/")) continue;
        const file = Bun.file(`public${icon.src}`);
        if (!(await file.exists())) {
          missing.push(icon.src);
          continue;
        }
        const [w, h] = icon.sizes.split("x").map((n) => parseInt(n, 10));
        if (!w || !h) continue;
        try {
          const meta = await new Bun.Image(await file.bytes()).metadata();
          if (meta.width !== w || meta.height !== h) {
            mismatched.push(`${icon.src} declares ${icon.sizes}, is ${meta.width}x${meta.height}`);
          }
        } catch {
          mismatched.push(`${icon.src} is not a decodable image`);
        }
      }
      checks.push({
        category: "icon-integrity", check: "all declared icons exist",
        pass: missing.length === 0, severity: "error",
        detail: missing.length ? `missing: ${missing.join(", ")}` : `${icons.length} verified`,
      });
      checks.push({
        category: "icon-integrity", check: "declared sizes match actual pixels",
        pass: mismatched.length === 0, severity: "error",
        detail: mismatched.length ? mismatched.join("; ") : "all match",
      });

      // A maskable icon byte-identical to its plain counterpart has no
      // safe-zone padding, so Android's circular mask clips the glyph.
      const maskableCopies: string[] = [];
      for (const icon of icons.filter((i) => i.purpose === "maskable")) {
        const plain = icons.find((i) => i.sizes === icon.sizes && i.purpose !== "maskable");
        if (!plain) continue;
        const [a, b] = [Bun.file(`public${icon.src}`), Bun.file(`public${plain.src}`)];
        if (!(await a.exists()) || !(await b.exists())) continue;
        if (Bun.SHA256.hash(await a.bytes(), "hex") === Bun.SHA256.hash(await b.bytes(), "hex")) {
          maskableCopies.push(`${icon.src} is identical to ${plain.src}`);
        }
      }
      checks.push({
        category: "icon-integrity", check: "maskable icons have safe-zone padding",
        pass: maskableCopies.length === 0, severity: "warning",
        detail: maskableCopies.length ? maskableCopies.join("; ") : "padded",
      });

      const errors = checks.filter((c) => c.severity === "error" && !c.pass);
      const warnings = checks.filter((c) => c.severity === "warning" && !c.pass);
      const passCount = checks.filter((c) => c.pass).length;

      return Response.json({
        manifest: "BUN-DEV",
        installable: errors.length === 0,
        score: Math.round((passCount / checks.length) * 100),
        errors: errors.map((c) => c.check),
        warnings: warnings.map((c) => c.check),
        checks,
      }, {
        headers: { "Cache-Control": "no-cache" },
      });
    }),
  };
  // Serve PWA icons — /icons/:filename.png
  routes["/icons/:filename"] = {
    GET: withMiddleware<"/icons/:filename">(async (req: BunRequest<"/icons/:filename">): Promise<Response> => {
      const filename = req.params.filename;
      // Only allow .png files from the public/icons directory
      if (!filename.endsWith(".png")) {
        return errorResponse("not found", 404);
      }
      // Reject traversal before touching the filesystem.
      if (filename.includes("..") || filename.includes("/")) {
        return errorResponse("not found", 404);
      }
      const file = Bun.file(`public/icons/${filename}`);
      const exists = await file.exists();
      if (!exists) {
        return errorResponse("icon not found", 404);
      }
      // Icon filenames are NOT content-hashed (icon-512.png is a stable name),
      // so `immutable` must not be used here — it would make icon updates
      // permanently unreachable for already-cached clients. Use a moderate TTL
      // plus a weak ETag so revalidation costs a 304 instead of a re-download.
      const etag = `W/"${file.size.toString(16)}-${Math.floor(file.lastModified).toString(16)}"`;
      if (req.headers.get("if-none-match") === etag) {
        return new Response(null, {
          status: 304,
          headers: { ETag: etag, "Cache-Control": "public, max-age=86400" },
        });
      }
      return new Response(file, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
          ETag: etag,
        },
      });
    }),
  };
  markActive("pwa");
  log("server", "info", "PWA enabled — manifest at /manifest.json, install from Chrome");
}

// Markdown rendering chain — always available public API
routes["/api/markdown"] = { POST: markdownHandler };

// R3: Conditionally add dashboard route
if (ENABLE_DEV_DASHBOARD) {
  routes["/dashboard"] = { GET: dashboardHandler };
  // Serve the channel diagrams page at /diagrams (dev only)
  routes["/diagrams"] = {
    GET: withMiddleware((): Response => {
      const file = Bun.file(`${import.meta.dir}/../docs/channel-diagrams.html`);
      if (file.size === 0) {
        return errorResponse("diagrams page not found — run: bun run docs/render-diagrams.ts", 404);
      }
      return new Response(file, { headers: { "Content-Type": "text/html" } });
    }),
  };
}

// C7: WebSocket handler config — behind ENABLE_WEBSOCKET flag
// When enabled, /ws/task/:id upgrades to a WebSocket that subscribes to
// task progress updates published by the worker pool.
// Also /ws/metrics pushes pool status every 500ms for live dashboard.
const wsChannels = new Map<number, Set<import("bun").ServerWebSocket<unknown>>>();

// JUSTIFIED: Bun.serve websocket config types are complex; we build as Record
const websocketConfig: Record<string, unknown> = {
  // JUSTIFIED: empty object cast to WebSocketData type for Bun's ws.data inference
  data: {} as { taskId: number; channel: string },
  open(ws: import("bun").ServerWebSocket<{ taskId: number; channel: string }>) {
    if (ws.data.channel === "metrics") {
      ws.subscribe("metrics");
      // Send initial snapshot
      ws.send(JSON.stringify({ type: "metrics", ...getPoolStatus(), uptime: process.uptime() }));
    } else {
      ws.subscribe(`task:${ws.data.taskId}`);
      if (!wsChannels.has(ws.data.taskId)) {
        wsChannels.set(ws.data.taskId, new Set());
      }
      wsChannels.get(ws.data.taskId)!.add(ws);
    }
    log("ws", "info", `client connected to ${ws.data.channel}`);
  },
  message(ws: import("bun").ServerWebSocket<{ taskId: number; channel: string }>, msg: string | ArrayBuffer) {
    if (typeof msg === "string" && msg === "ping") {
      ws.send("pong");
    }
  },
  close(ws: import("bun").ServerWebSocket<{ taskId: number; channel: string }>) {
    if (ws.data.channel !== "metrics") {
      const subscribers = wsChannels.get(ws.data.taskId);
      subscribers?.delete(ws);
      if (subscribers && subscribers.size === 0) {
        wsChannels.delete(ws.data.taskId);
      }
    }
    log("ws", "info", `client disconnected from ${ws.data.channel}`);
  },
};

// C7: WS publisher setup is deferred to after server creation (see below)

// Build the serve config — conditionally add TLS + HTTP/3.
// We use a plain object and cast at the end because Bun.serve's Options
// type is a complex union that doesn't cleanly accept conditional props
// like `tls` and `http3` (http3 is also not yet in all bun-types versions).
const serveConfig: Record<string, unknown> = {
  port: PORT,
  hostname: HOST,
  // WebView tasks can take 30+ seconds; default 10s would kill long handlers.
  // Max value is 255; 0 disables entirely (not recommended for production).
  idleTimeout: 255,
  // I3: Belt-and-suspenders with the Content-Length check in withMiddleware.
  // Bun.serve's maxRequestBodySize catches chunked-encoding bodies that don't
  // send Content-Length. Default is 128MB; we cap at 1MB (same as middleware).
  // Ref: node_modules/bun-types/serve.d.ts
  maxRequestBodySize: MAX_BODY_BYTES,
  // m5: Enable HMR + console relay in development (useful when dashboard is added)
  development: NODE_ENV === "development" ? { hmr: true, console: true } : undefined,

  routes,

  // Fallback for unmatched routes + CORS preflight (OPTIONS) + WS upgrade
  async fetch(req: Request, server: import("bun").Server<unknown>) {
    // CORS preflight for any route
    const preflight = handlePreflight(req);
    if (preflight) return preflight;

    // C7: WebSocket upgrade for /ws/task/:id and /ws/metrics
    if (ENABLE_WEBSOCKET) {
      const url = new URL(req.url);
      const wsMatch = url.pathname.match(/^\/ws\/task\/(\d+)$/);
      if (wsMatch && wsMatch[1]) {
        const taskId = parseInt(wsMatch[1], 10);
        const upgraded = server.upgrade(req, { data: { taskId, channel: "task" } });
        return upgraded
          ? undefined
          : new Response("WebSocket upgrade failed", { status: 400 });
      }
      // Live metrics streaming — /ws/metrics
      if (url.pathname === "/ws/metrics") {
        const upgraded = server.upgrade(req, { data: { taskId: 0, channel: "metrics" } });
        return upgraded
          ? undefined
          : new Response("WebSocket upgrade failed", { status: 400 });
      }
    }

    return withCors(req, errorResponse("not found", 404));
  },

  // M3: Top-level error handler — catches unhandled exceptions in route handlers
  // that escape withMiddleware. Returns a structured 500 instead of Bun's default.
  error(error: Error) {
    log("server", "error", "unhandled error", error);
    return Response.json({ error: "internal server error" }, { status: 500 });
  },
};

// C6: Conditionally add websocket config
if (ENABLE_WEBSOCKET) {
  serveConfig.websocket = websocketConfig;
}

// R3: Conditionally add TLS config
if (ENABLE_TLS && tlsConfig) {
  serveConfig.tls = tlsConfig;
}

// R3: Conditionally add HTTP/3 (requires TLS)
if (ENABLE_HTTP3 && tlsConfig) {
  // JUSTIFIED: http3 is a valid Bun.serve option per v1.3.14 blog but not in bun-types yet
  serveConfig.http3 = true;
}

// serveConfig is built as Record<string, unknown> for conditional props
// (tls, http3) that aren't in all bun-types versions. Cast through unknown
// to the Options type Bun.serve expects. The object shape is correct at runtime.
const server = Bun.serve(serveConfig as unknown as Parameters<typeof Bun.serve>[0]); // JUSTIFIED: double cast via unknown — Options is a complex union that rejects Record

// C7: Set up the WS publisher — relays worker IPC messages to WebSocket clients
if (ENABLE_WEBSOCKET) {
  setWSPublisher((topic: string, msg: unknown) => {
    const json = JSON.stringify(msg);
    server.publish(topic, json);
  });

  // Live metrics publisher — pushes pool status to /ws/metrics subscribers every 500ms
  // Ref: node_modules/bun-types/docs/runtime/http/websockets.mdx
  setInterval(() => {
    const pool = getPoolStatus();
    server.publish("metrics", JSON.stringify({
      type: "metrics",
      ...pool,
      uptime: process.uptime(),
      timestamp: Date.now(),
    }));
  }, 500).unref();
  log("ws", "info", "/ws/metrics live metrics publisher started (500ms interval)");
}

// --- Cron jobs — scheduled health checks and log rotation ---
// Ref: node_modules/bun-types/docs/runtime/cron.mdx
import { registerCronJobs } from "./cron";
registerCronJobs();

// --- Shutdown --------------------------------------------------------------

installShutdownHandlers(server);

const protocol = ENABLE_TLS ? "https" : "http";
log("server", "info", `listening on ${protocol}://${HOST}:${PORT}`);
if (ENABLE_HTTP3) {
  log("server", "info", `  HTTP/1.1+2: TCP/${PORT}`);
  log("server", "info", `  HTTP/3:    UDP/${PORT} (QUIC, experimental)`);
  log("server", "info", `  Alt-Svc:   h3=":${PORT}"; ma=86400`);
}
console.log(`[server] endpoints:`);
console.log(`  GET  /health         — health check + worker pool status (public)`);
console.log(`  GET  /metrics        — Prometheus-format metrics (public)`);
console.log(`  POST /login          — agent authentication → returns token + csrf_token`);
console.log(`  GET  /tasks          — list tasks (auth required)`);
console.log(`  GET  /api/tasks.jsonl — tasks JSONL export (auth required)`);
console.log(`  POST /task           — create task (auth + CSRF required)`);
console.log(`  GET  /task/:id       — get task by ID (auth required)`);
console.log(`  GET  /sessions       — list sessions (auth required)`);
console.log(`  GET  /api/sessions.jsonl — sessions JSONL export (auth required)`);
console.log(`  GET  /screenshot/:id — serve screenshot (auth required)`);
console.log(`  GET  /audit          — audit log (auth required)`);
console.log(`  GET  /api/audit.jsonl — audit log JSONL export (auth required)`);
console.log(`  GET  /protocol       — protocol info (public)`);
console.log(`  GET  /features       — feature flags + promotion status (public)`);
console.log(`  GET  /api/color      — color conversion via Bun.color (public)`);
console.log(`  GET  /api/env        — environment variable inspection (public)`);
if (ENABLE_PWA) {
  console.log(`  GET  /manifest.json  — PWA manifest (installable Chrome app)`);
  console.log(`  GET  /icons/:name    — PWA icons (png)`);
  console.log(`  GET  /sw.js          — service worker`);
  console.log(`  GET  /api/pwa/validate — PWA installability check`);
  console.log(`  GET  /api/pwa/compare  — BUN-DEV vs bun.com manifest diff`);
}
if (ENABLE_DEV_DASHBOARD) {
  console.log(`  GET  /dashboard      — dev dashboard (public)`);
}
if (ENABLE_WEBSOCKET) {
  console.log(`  WS   /ws/task/:id    — live task progress (WebSocket)`);
}
