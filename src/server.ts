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
import { isFeatureEnabled, shouldActivate, markActive, markBlocked, listFeatures, getFeatureSummary } from "./features/registry";
import { setWSPublisher } from "./workers/pool";

// --- Config ----------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
const NODE_ENV = process.env.NODE_ENV ?? "development";

// --- Feature flags ---------------------------------------------------------
// R3: Conditionally enable TLS, HTTP/3, and dev dashboard behind flags.
// Each flag is tracked in src/features/registry.ts with promotion status.
// D5: Use shouldActivate() which checks deps + marks blocked, then markActive()
// after the feature is actually running. This ensures /features endpoint
// shows accurate runtime state, not just env-var state.

// D4: HTTP/3 requested without TLS → fail loudly, don't silently disable.
if (isFeatureEnabled("http3") && !isFeatureEnabled("tls")) {
  console.error("[server] ENABLE_HTTP3=1 requires ENABLE_TLS=1 (HTTP/3 mandates TLS)");
  process.exit(1);
}

const ENABLE_TLS = shouldActivate("tls");
const ENABLE_HTTP3 = shouldActivate("http3");
// Dev dashboard auto-enables in development mode unless explicitly disabled
const ENABLE_DEV_DASHBOARD = isFeatureEnabled("devDashboard") ||
  (NODE_ENV === "development" && process.env.ENABLE_DEV_DASHBOARD !== "0");
// C6: WebSocket support — behind ENABLE_WEBSOCKET flag
const ENABLE_WEBSOCKET = shouldActivate("websocket");

// TLS cert/key — only loaded if ENABLE_TLS is true
let tlsConfig: { cert: string; key: string } | undefined;
if (ENABLE_TLS) {
  const certPath = process.env.TLS_CERT_PATH ?? "dev-cert.pem";
  const keyPath = process.env.TLS_KEY_PATH ?? "dev-key.pem";
  const certFile = Bun.file(certPath);
  const keyFile = Bun.file(keyPath);
  if (!(await certFile.exists()) || !(await keyFile.exists())) {
    console.error(
      `[server] ENABLE_TLS=1 but cert/key not found at ${certPath}/${keyPath}.\n` +
      `Generate with:\n` +
      `  openssl req -x509 -newkey rsa:2048 -keyout dev-key.pem -out dev-cert.pem -days 365 -nodes -subj "/CN=localhost"`,
    );
    markBlocked("tls", `cert/key not found at ${certPath}/${keyPath}`);
    process.exit(1);
  }
  tlsConfig = { cert: await certFile.text(), key: await keyFile.text() };
  markActive("tls");
  console.log(`[server] TLS enabled (cert: ${certPath})`);
}

if (ENABLE_HTTP3) {
  if (!ENABLE_TLS) {
    markBlocked("http3", "requires tls to be enabled");
    console.error("[server] ENABLE_HTTP3=1 requires ENABLE_TLS=1 (HTTP/3 mandates TLS)");
    process.exit(1);
  }
  markActive("http3");
  console.log("[server] HTTP/3 (QUIC) enabled — experimental, not for production yet");
  console.log("         Ref: https://bun.sh/blog/bun-v1.3.14#http-3-quic-support-in-bun-serve");
}

if (ENABLE_DEV_DASHBOARD) {
  markActive("devDashboard");
  console.log("[server] Dev dashboard enabled at /dashboard");
}

if (ENABLE_WEBSOCKET) {
  markActive("websocket");
  console.log("[server] WebSocket enabled — /ws/task/:id for live progress");
}

console.log(`[server] feature flags: ${getFeatureSummary()}`);

// F7: Pre-compute a real Argon2id hash at startup for the login timing oracle
// mitigation (E2). Using a real hash with the same parameters as
// Bun.password.hash() ensures the dummy verify takes nearly the same time as
// a real "wrong password" verify. Generated once at startup, reused for all
// non-existent-user login attempts.
const DUMMY_PASSWORD_HASH = await Bun.password.hash("dummy-password-that-never-matches");

// G10: Max request body size (1 MB). Prevents OOM from oversized payloads.
const MAX_BODY_BYTES = 1_048_576;

// --- Init ------------------------------------------------------------------

console.log(`[server] starting in ${NODE_ENV} mode on ${HOST}:${PORT}`);

// Run migrations
await migrate();
console.log("[server] database migrated");

// Initialize worker pool
await initWorkerPool();

// Periodic cleanup of old rate limit entries
// D11: Catch the promise rejection from write() — don't let it become an
// unhandled rejection that crashes the process.
setInterval(() => {
  cleanupRateLimits().catch((e) => console.error("[server] rate limit cleanup failed:", e));
}, 300_000); // every 5 min

// E10: Periodic cleanup of expired auth sessions — prevents unbounded growth.
setInterval(() => {
  write((db) => {
    db.query("DELETE FROM auth_sessions WHERE expires_at <= datetime('now')").run();
  }).catch((e) => console.error("[server] session cleanup failed:", e));
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

function json(data: unknown, status = 200): Response {
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

    const rl = await checkRateLimit(ip, path, req.method);
    if (!rl.allowed) {
      return withCors(req, errorResponse("Too Many Requests", 429));
    }

    // G10: Reject requests with oversized bodies before parsing JSON.
    // Prevents OOM from multi-GB payloads. 1MB is generous for login/task JSON.
    const contentLength = req.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
      return withCors(req, errorResponse("request body too large", 413));
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
    // JUSTIFIED: bun:sqlite .all() returns unknown[]; narrowing to the count row type
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

    return json({ token: authToken, csrf_token: csrfToken, agent_id: agent.id, username: agent.username });
  } catch (err) {
    // G3: Distinguish JSON parse errors (400) from unexpected errors (500).
    // Previously all errors returned "invalid request body" which hid DB
    // failures, hash failures, etc. Now only SyntaxError (JSON parse) gets 400.
    if (err instanceof SyntaxError) {
      return errorResponse("invalid request body", 400);
    }
    console.error("[server] login error:", err);
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
      console.error(`[server] task ${taskId} failed:`, err);
      try {
        await write((db) => {
          db.query(
            `UPDATE tasks SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ? AND status = 'running'`,
          ).run(err instanceof Error ? err.message : String(err), taskId);
        });
      } catch (dbErr) {
        console.error(`[server] failed to mark task ${taskId} as failed:`, dbErr);
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
    console.error("[server] serveScreenshot error:", err);
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

// R5: Dev dashboard — simple HTML page showing server status.
// Will be replaced with React + HTML imports dashboard (OPEN_TASKS F1).
// D6: Dashboard is dev-only — auto-disabled in production unless explicitly enabled.
const dashboardHandler = withMiddleware((): Response => {
  const pool = getPoolStatus();
  const features = listFeatures()
    .map((f) => `<tr><td>${f.key}</td><td>${f.status}</td><td>${f.active ? "✅ active" : f.blocked ? "⚠️ blocked" : "❌ off"}</td><td>${f.description}</td></tr>`)
    .join("\n");
  const html = `<!DOCTYPE html>
<html>
<head><title>Bun Automation Platform — Dashboard</title></head>
<body style="font-family: sans-serif; max-width: 800px; margin: 2rem auto;">
  <h1>Bun Automation Platform</h1>
  <p>Server running on Bun v${Bun.version}</p>
  <h2>Status</h2>
  <ul>
    <li>Environment: ${NODE_ENV}</li>
    <li>TLS: ${ENABLE_TLS ? "✅ enabled" : "❌ disabled"}</li>
    <li>HTTP/3: ${ENABLE_HTTP3 ? "✅ enabled (experimental)" : "❌ disabled"}</li>
    <li>Workers: ${pool.total} total, ${pool.busy} busy, ${pool.idle} idle</li>
    <li>Uptime: ${Math.floor(process.uptime())}s</li>
  </ul>
  <h2>Feature Flags</h2>
  <table border="1" cellpadding="4" style="border-collapse: collapse;">
    <tr><th>Feature</th><th>Status</th><th>Enabled</th><th>Description</th></tr>
    ${features}
  </table>
  <h2>Endpoints</h2>
  <ul>
    <li><a href="/health">/health</a> — health check</li>
    <li><a href="/metrics">/metrics</a> — Prometheus metrics</li>
    <li><a href="/protocol">/protocol</a> — protocol info</li>
    <li><a href="/features">/features</a> — feature flags</li>
    <li><a href="/dashboard">/dashboard</a> — this page</li>
  </ul>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html" } });
});

// Build the routes object — conditionally include dashboard routes
const routes: Record<string, unknown> = {
  // Public routes (no auth)
  "/health": { GET: healthHandler },
  "/metrics": { GET: metricsHandler },
  "/login": { POST: loginHandler },
  "/protocol": { GET: protocolHandler },
  "/features": { GET: featuresHandler },

  // Auth-required routes
  "/tasks": { GET: listTasksHandler },
  "/task": { POST: createTaskHandler },       // also requires CSRF
  "/task/:id": { GET: getTaskHandler },
  "/sessions": { GET: listSessionsHandler },
  "/screenshot/:id": { GET: getScreenshotHandler },
  "/audit": { GET: auditHandler },
};

// R3: Conditionally add dashboard route
if (ENABLE_DEV_DASHBOARD) {
  routes["/dashboard"] = { GET: dashboardHandler };
}

// C7: WebSocket handler config — behind ENABLE_WEBSOCKET flag
// When enabled, /ws/task/:id upgrades to a WebSocket that subscribes to
// task progress updates published by the worker pool.
const wsChannels = new Map<number, Set<import("bun").ServerWebSocket<unknown>>>();

// JUSTIFIED: Bun.serve websocket config types are complex; we build as Record
const websocketConfig: Record<string, unknown> = {
  // JUSTIFIED: empty object cast to WebSocketData type for Bun's ws.data inference
  data: {} as { taskId: number },
  open(ws: import("bun").ServerWebSocket<{ taskId: number }>) {
    ws.subscribe(`task:${ws.data.taskId}`);
    if (!wsChannels.has(ws.data.taskId)) {
      wsChannels.set(ws.data.taskId, new Set());
    }
    wsChannels.get(ws.data.taskId)!.add(ws);
    console.log(`[ws] client subscribed to task:${ws.data.taskId}`);
  },
  message(ws: import("bun").ServerWebSocket<{ taskId: number }>, msg: string | ArrayBuffer) {
    // Client can send "ping" to keep connection alive
    if (typeof msg === "string" && msg === "ping") {
      ws.send("pong");
    }
  },
  close(ws: import("bun").ServerWebSocket<{ taskId: number }>) {
    const subscribers = wsChannels.get(ws.data.taskId);
    subscribers?.delete(ws);
    // E9b/Bug 5: Clean up empty sets to prevent memory leak.
    // Without this, the Map grows unboundedly as new tasks are created.
    if (subscribers && subscribers.size === 0) {
      wsChannels.delete(ws.data.taskId);
    }
    console.log(`[ws] client unsubscribed from task:${ws.data.taskId}`);
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

    // C7: WebSocket upgrade for /ws/task/:id
    if (ENABLE_WEBSOCKET) {
      const url = new URL(req.url);
      const wsMatch = url.pathname.match(/^\/ws\/task\/(\d+)$/);
      if (wsMatch && wsMatch[1]) {
        const taskId = parseInt(wsMatch[1], 10);
        const upgraded = server.upgrade(req, { data: { taskId } });
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
    console.error("[server] unhandled error:", error);
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
}

// --- Shutdown --------------------------------------------------------------

installShutdownHandlers(server);

const protocol = ENABLE_TLS ? "https" : "http";
console.log(`[server] listening on ${protocol}://${HOST}:${PORT}`);
if (ENABLE_HTTP3) {
  console.log(`[server]   HTTP/1.1+2: TCP/${PORT}`);
  console.log(`[server]   HTTP/3:    UDP/${PORT} (QUIC, experimental)`);
  console.log(`[server]   Alt-Svc:   h3=":${PORT}"; ma=86400`);
}
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
console.log(`  GET  /protocol       — protocol info (public)`);
console.log(`  GET  /features       — feature flags + promotion status (public)`);
if (ENABLE_DEV_DASHBOARD) {
  console.log(`  GET  /dashboard      — dev dashboard (public)`);
}
if (ENABLE_WEBSOCKET) {
  console.log(`  WS   /ws/task/:id    — live task progress (WebSocket)`);
}
