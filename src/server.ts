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
import { migrate, write } from "./db";
import { getFeatureSummary, isFeatureEnabled, markActive, markBlocked, shouldActivate } from "./features/registry";
import { cleanupRateLimits } from "./middleware/rate-limit";
import { adminRoutes, setPrepareForExecve, setReloadRoutes } from "./routes/admin";
import { apiRoutes } from "./routes/api";
import { authRoutes, setDummyPasswordHash } from "./routes/auth";
import { dashboardRoutes, setDashboardConfig } from "./routes/dashboard";
import { fallbackFetch, setFallbackConfig } from "./routes/fallback";
// Route modules — split from this file for maintainability.
// Ref: https://bun.com/docs/runtime/http/routing
// Ref: https://github.com/oven-sh/bun/issues/23182 (router() type helper pattern)
import { healthRoutes, setRoutesRef } from "./routes/health";
import { buildPwaRoutes, setPwaConfig } from "./routes/pwa";
import { errorResponse, MAX_BODY_BYTES, withMiddleware } from "./routes/shared";
import { setSitemapRoutesRef, sitemapRoutes } from "./routes/sitemap";
import { taskRoutes } from "./routes/tasks";
import { log } from "./utils/log";
import { installShutdownHandlers, prepareForExecve } from "./utils/shutdown";
import { getPoolStatus, initWorkerPool, setWSPublisher } from "./workers/pool";

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
const ENABLE_DEV_DASHBOARD =
  isFeatureEnabled("devDashboard") || (NODE_ENV === "development" && process.env.ENABLE_DEV_DASHBOARD !== "0");
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

// G10: Max request body size (1 MB) — imported from routes/shared.ts.

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

// Build the routes object — conditionally include dashboard routes.
// Extracted into a function so server.reload() can rebuild routes at runtime
// (e.g. after a feature flag toggle). Ref: bun-v1.3.14 blog — server.reload()
//
// IMPORTANT: This function reads live feature state via isFeatureEnabled(),
// NOT the startup-time consts (ENABLE_SITEMAP, etc.). The consts are frozen
// at module load and only used for server-level config (TLS, HTTP/3, websocket)
// that can't be reloaded. Routes can be toggled at runtime via toggleFeature().
function buildRoutes(): Record<string, unknown> {
  // Read live feature state — respects runtimeOverrides set by toggleFeature()
  const sitemapEnabled = isFeatureEnabled("sitemap");
  const dashboardEnabled =
    isFeatureEnabled("devDashboard") || (NODE_ENV === "development" && process.env.ENABLE_DEV_DASHBOARD !== "0");
  const pwaEnabled = isFeatureEnabled("pwa");

  // Update config setters so route modules see the current state on reload
  setDashboardConfig({
    ENABLE_PWA: pwaEnabled,
    ENABLE_TLS,
    ENABLE_HTTP3,
    ENABLE_SITEMAP: sitemapEnabled,
    ENABLE_HTML_REWRITER,
    NODE_ENV,
  });
  setPwaConfig({ ENABLE_PWA: pwaEnabled });

  const r: Record<string, unknown> = {
    // Route modules — split into src/routes/*.ts for maintainability.
    // Each module uses the router() type helper to preserve BunRequest<T>
    // param inference when spread here.
    // Ref: https://github.com/oven-sh/bun/issues/23182
    ...healthRoutes,
    ...authRoutes,
    ...taskRoutes,
    ...adminRoutes,
    ...apiRoutes,
  };

  // Sitemap feature flag — enable the route when enabled (live state)
  if (sitemapEnabled) {
    Object.assign(r, sitemapRoutes);
  }

  // Markdown rendering chain — always available public API
  r["/api/markdown"] = { POST: markdownHandler };

  // R3: Conditionally add dashboard route (live state)
  if (dashboardEnabled) {
    Object.assign(r, dashboardRoutes);
    // Serve the channel diagrams page at /diagrams (dev only)
    r["/diagrams"] = {
      GET: withMiddleware((): Response => {
        const file = Bun.file(`${import.meta.dir}/../docs/channel-diagrams.html`);
        if (file.size === 0) {
          return errorResponse("diagrams page not found — run: bun run docs/render-diagrams.ts", 404);
        }
        return new Response(file, { headers: { "Content-Type": "text/html" } });
      }),
    };
  }

  // PWA routes — conditionally built from the pwa module (reads pwaEnabled)
  Object.assign(r, buildPwaRoutes());

  return r;
}

// Pass feature flags to route modules BEFORE building routes — buildPwaRoutes()
// and other conditional route builders read these flags at call time.
// Note: buildRoutes() also calls these setters with live state on each reload.
setFallbackConfig({ ENABLE_WEBSOCKET });
setDummyPasswordHash(DUMMY_PASSWORD_HASH);

const routes = buildRoutes();

// Wire up cross-module references after route composition.
setRoutesRef(routes);
setSitemapRoutesRef(routes);

// Sitemap feature flag — mark active when requested
if (ENABLE_SITEMAP) {
  markActive("sitemap");
}

// HTMLRewriter feature flag — mark active (no route needed; it transforms
// existing HTML responses from /dashboard and /api/markdown)
if (ENABLE_HTML_REWRITER) {
  markActive("htmlRewriter");
  log("server", "info", "HTMLRewriter enabled — injecting into HTML responses");
}

// C7: WebSocket handler config — behind ENABLE_WEBSOCKET flag
// When enabled, /ws/task/:id upgrades to a WebSocket that subscribes to
// task progress updates published by the worker pool.
// Also /ws/metrics pushes pool status every 500ms for live dashboard.
const wsChannels = new Map<number, Set<import("bun").ServerWebSocket<unknown>>>();

// JUSTIFIED: Bun.serve websocket config types are complex; we build as Record
const websocketConfig: Record<string, unknown> = {
  // perMessageDeflate: false — our WS traffic is small JSON metrics (500ms)
  // and task progress updates. Compression overhead isn't worth it for these
  // small payloads. Ref: bun-v1.3.14 blog — perMessageDeflate now respected.
  perMessageDeflate: false,
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
  // Delegated to src/routes/fallback.ts for clean separation.
  fetch: fallbackFetch,

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

/**
 * Reload routes at runtime without restarting the server.
 * Rebuilds the routes object from current feature flags and calls server.reload().
 * Useful for feature flag toggles — toggle a flag, then reload routes.
 *
 * Ref: bun-v1.3.14 blog — server.reload({ routes: { ... } })
 * Ref: node_modules/bun-types/docs/runtime/http/server.mdx
 */
export function reloadRoutes(): void {
  const newRoutes = buildRoutes();
  // Update the shared references that other modules (health, sitemap) hold.
  // We pass the new object directly — no in-place mutation of the old `routes`
  // const, which avoids a race where an in-flight request could see an empty
  // routes object between delete and assign.
  setRoutesRef(newRoutes);
  setSitemapRoutesRef(newRoutes);
  // JUSTIFIED: server.reload accepts a partial config — we only pass routes.
  // The type requires the full Options shape (including websocket), but at
  // runtime reload() merges the new routes into the existing config.
  // Ref: node_modules/bun-types/docs/runtime/http/server.mdx — reload()
  // JUSTIFIED: double cast via unknown — reload accepts partial Options
  server.reload({ routes: newRoutes } as unknown as Parameters<typeof server.reload>[0]);
  log("server", "info", `routes reloaded (${Object.keys(newRoutes).length} routes)`);
}

// Wire reloadRoutes into the admin module so feature toggles can trigger a reload
setReloadRoutes(reloadRoutes);

// Wire prepareForExecve into the admin module so the self-update endpoint
// can gracefully stop the server, notify workers, and close the DB before
// replacing the process image via execve().
setPrepareForExecve(() => prepareForExecve(server));

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
    server.publish(
      "metrics",
      JSON.stringify({
        type: "metrics",
        ...pool,
        uptime: process.uptime(),
        timestamp: Date.now(),
      }),
    );
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
