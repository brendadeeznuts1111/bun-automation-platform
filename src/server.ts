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

// R5: Dev dashboard — simple HTML page showing server status.
// Will be replaced with React + HTML imports dashboard (OPEN_TASKS F1).
// D6: Dashboard is dev-only — auto-disabled in production unless explicitly enabled.
const dashboardHandler = withMiddleware((): Response => {
  const pool = getPoolStatus();
  const features = listFeatures()
    .map((f) => `<tr><td>${f.key}</td><td>${f.status}</td><td>${f.active ? "✅ active" : f.blocked ? "⚠️ blocked" : "❌ off"}</td><td>${f.description}</td></tr>`)
    .join("\n");
  const pwaLinks = ENABLE_PWA
    ? `<link rel="manifest" href="/manifest.json">
  <link rel="icon" type="image/png" sizes="128x128" href="/icons/icon-128.png">
  <link rel="apple-touch-icon" href="/icons/icon-192.png">`
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
    footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--fg-dim); font-size: 0.75rem; text-align: center; }
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
    ${ENABLE_PWA ? '<span class="sw-badge" id="sw-status">SW: checking...</span>' : ""}
  </div>
  <p style="color: var(--fg-dim); font-size: 0.85rem; margin-bottom: 1rem;">Bun Automation Platform — Player Health Dashboard</p>

  <h2>Status</h2>
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
      <div class="value">${pool.idle}/${pool.total} idle</div>
    </div>
    <div class="stat-card">
      <div class="label">Uptime</div>
      <div class="value" id="uptime">${Math.floor(process.uptime())}s</div>
    </div>
    <div class="stat-card">
      <div class="label">PWA</div>
      <div class="value ${ENABLE_PWA ? "" : "warn"}">${ENABLE_PWA ? "Enabled" : "Off"}</div>
    </div>
  </div>

  <h2>Feature Flags</h2>
  <table>
    <tr><th>Feature</th><th>Status</th><th>State</th><th>Description</th></tr>
    ${features}
  </table>
  <div id="features-panel">
    <h3 style="cursor:pointer; color:var(--accent);" onclick="document.getElementById('features-panel').style.display='none'">Live Feature Flags ✕</h3>
    <pre id="features-output">Loading...</pre>
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

  <h2>Endpoints</h2>
  <ul>
    <li><a href="/health">/health</a> — health check (JSON)</li>
    <li><a href="/metrics">/metrics</a> — Prometheus metrics</li>
    ${ENABLE_SITEMAP ? '<li><a href="/sitemap.xml">/sitemap.xml</a> — sitemap XML</li>' : ""}
    <li><a href="/protocol">/protocol</a> — protocol info</li>
    <li><a href="/features">/features</a> — feature flags (JSON)</li>
    <li><a href="/dashboard">/dashboard</a> — this page</li>
    <li><code>GET /api/audit.jsonl</code> — audit log JSONL export</li>
    <li><code>GET /api/tasks.jsonl</code> — tasks JSONL export</li>
    <li><code>GET /api/sessions.jsonl</code> — sessions JSONL export</li>
    <li><code>GET /api/color?color=red&amp;format=css</code> — color conversion</li>
    <li><code>GET /api/env</code> — environment variable inspection</li>
    <li><a href="/manifest.json">/manifest.json</a> — PWA manifest</li>
    <li><a href="/sw.js">/sw.js</a> — service worker</li>
    <li><a href="/api/pwa/validate">/api/pwa/validate</a> — PWA installability validation</li>
    <li><a href="/api/pwa/compare">/api/pwa/compare</a> — BUN-DEV vs bun.com manifest comparison</li>
    <li><code>POST /api/markdown</code> — render markdown to HTML</li>
  </ul>

  <footer>BUN-DEV — Bun Automation Platform | Powered by Bun v${Bun.version}</footer>

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
  </script>` : ""}
</body>
</html>`;
  let response = new Response(html, { headers: { "Content-Type": "text/html" } });

  // HTMLRewriter: dynamically inject theme-color meta, feature-flag script,
  // and a data-rewritten attribute into the dashboard HTML.
  // Ref: https://bun.com/docs/runtime/htmlrewriter
  // Ref: https://bun.com/docs/runtime/color — Bun.color normalizes the input
  if (ENABLE_HTML_REWRITER) {
    const activeFlags = listFeatures()
      .filter((f) => f.active)
      .map((f) => `'${f.key}': true`)
      .join(",");
    const flagScript = `<script>window.__FEATURE_FLAGS__ = {${activeFlags}};</script>`;
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
          // Inject feature flags as a client-side global
          el.append(flagScript, { html: true });
        },
      })
      .on("body", {
        element(el) {
          el.setAttribute("data-html-rewritten", "true");
        },
      })
      .transform(response);
  }

  return response;
});

// Sitemap XML — lists all public static routes
// Ref: node_modules/bun-types/docs/runtime/http/server.mdx
// TODO: Bun v1.4 adds Bun.XML.stringify(); when the project upgrades, replace
//       the manual string builder with a structured object. See:
//       https://bun.sh/docs/runtime/xml
function sitemapHandler(req: BunRequest): Response {
  const url = new URL(req.url);
  const base = `${url.protocol}//${url.host}`;
  const lastmod = new Date().toISOString();
  const paths = Object.keys(routes).filter(
    (p) => !p.includes(":") && p !== "/sitemap.xml",
  );
  const urls = paths
    .map(
      (p) =>
        `  <url><loc>${base}${p}</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.5</priority></url>`,
    )
    .join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
  return new Response(xml, { headers: { "Content-Type": "application/xml" } });
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
  console.log("[server] HTMLRewriter enabled — injecting into HTML responses");
}

// PWA feature flag — serve manifest.json and icons so the dashboard can be
// installed as a Chrome standalone app.
// Ref: https://web.dev/articles/add-manifest
if (ENABLE_PWA) {
  // Serve the PWA manifest
  routes["/manifest.json"] = {
    GET: withMiddleware((): Response => {
      const manifest = Bun.file("public/manifest.json");
      return new Response(manifest, {
        headers: { "Content-Type": "application/manifest+json" },
      });
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
      const file = Bun.file(`public/icons/${filename}`);
      const exists = await file.exists();
      if (!exists) {
        return errorResponse("icon not found", 404);
      }
      return new Response(file, {
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
      });
    }),
  };
  markActive("pwa");
  console.log("[server] PWA enabled — manifest at /manifest.json, install from Chrome");
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
