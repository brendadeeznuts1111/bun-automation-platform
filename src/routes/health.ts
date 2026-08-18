// Health, metrics, and info routes.
//
// Ref: https://bun.com/docs/runtime/http/routing

import type { BunRequest } from "bun";
import { read } from "../db";
import { listFeatures } from "../features/registry";
import { TaskStatusCountRow } from "../types/models";
import { isShuttingDown } from "../utils/shutdown";
import { getPoolStatus } from "../workers/pool";
import { router } from "./router";
import { errorResponse, json, withMiddleware } from "./shared";

// --- Routes object reference (set by server.ts after route composition) ---

let routesRef: Record<string, unknown> = {};

/** Called by server.ts so /metrics and /api/openapi.json can introspect routes. */
export function setRoutesRef(ref: Record<string, unknown>): void {
  routesRef = ref;
}

// --- Handlers ---------------------------------------------------------------

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
    return db.query(`SELECT status, COUNT(*) as count FROM tasks GROUP BY status`).as(TaskStatusCountRow).all();
  });

  const pool = getPoolStatus();
  const routeCount = Object.keys(routesRef).length;
  const pwaRouteCount = Object.keys(routesRef).filter(
    (r) => r.includes("manifest") || r.includes("sw.js") || r.includes("icons") || r.includes("pwa"),
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
    `pwa{enabled="${process.env.ENABLE_PWA === "1" ? "true" : "false"}"} 1`,
    `features{type="active"} ${listFeatures().filter((f) => f.active).length}`,
    `features{type="total"} ${listFeatures().length}`,
  ].join("\n");

  return new Response(metrics, {
    headers: { "Content-Type": "text/plain; version=0.0.4" },
  });
});

const protocolHandler = withMiddleware((req: BunRequest<"">) => {
  const url = new URL(req.url);
  return json({
    scheme: url.protocol.replace(":", ""),
    method: req.method,
    url: req.url,
    userAgent: req.headers.get("user-agent"),
    http3Enabled: process.env.ENABLE_HTTP3 === "1",
    altSvc: process.env.ENABLE_HTTP3 === "1" ? `h3=":${process.env.PORT ?? "3000"}"; ma=86400` : null,
    note: "Check browser devtools Network tab — protocol column shows h3 or http/1.1",
  });
});

const featuresHandler = withMiddleware((): Response => {
  return json({ features: listFeatures() });
});

const colorHandler = withMiddleware<"">((req: BunRequest<"">): Response => {
  const url = new URL(req.url);
  const input = url.searchParams.get("color");
  if (!input) {
    return errorResponse("missing 'color' query parameter", 400);
  }
  const format = url.searchParams.get("format") ?? "css";
  const validFormats = [
    "css",
    "ansi",
    "ansi-16",
    "ansi-256",
    "ansi-16m",
    "number",
    "rgb",
    "rgba",
    "hsl",
    "hex",
    "HEX",
    "{rgb}",
    "{rgba}",
    "[rgb]",
    "[rgba]",
  ];
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

const envHandler = withMiddleware<"">((req: BunRequest<"">): Response => {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  if (key) {
    const value = Bun.env[key];
    if (value === undefined) {
      return errorResponse(`env var '${key}' is not set`, 404);
    }
    return json({ key, value, source: "Bun.env" });
  }
  const safeKeys = [
    "NODE_ENV",
    "PORT",
    "HOST",
    "BUN_VERSION",
    "ENABLE_TLS",
    "ENABLE_HTTP3",
    "ENABLE_DEV_DASHBOARD",
    "ENABLE_WEBSOCKET",
    "ENABLE_SITEMAP",
    "ENABLE_HTML_REWRITER",
    "ENABLE_PWA",
    "NO_COLOR",
    "FORCE_COLOR",
    "TRUST_PROXY_HEADERS",
  ];
  const env: Record<string, string | undefined> = {};
  for (const k of safeKeys) {
    env[k] = Bun.env[k];
  }
  return json({
    env,
    aliases: {
      "process.env === Bun.env": process.env === Bun.env,
      "Bun.env === import.meta.env": Bun.env === import.meta.env,
    },
    bunVersion: Bun.version,
  });
});

const healthLogHandler = withMiddleware<"">((req: BunRequest<"">): Response => {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10), 100);
  const { getHealthLog } = require("../cron") as typeof import("../cron");
  return json({ entries: getHealthLog(limit) });
});

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
        responses: {
          "200": { description: "Success" },
          "401": { description: "Unauthorized" },
          "403": { description: "CSRF required" },
        },
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
  return json(generateOpenAPI(routesRef));
});

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

// --- Route exports ---------------------------------------------------------

export const healthRoutes = router({
  "/health": { GET: healthHandler },
  "/metrics": { GET: metricsHandler },
  "/protocol": { GET: protocolHandler },
  "/features": { GET: featuresHandler },
  "/api/color": { GET: colorHandler },
  "/api/env": { GET: envHandler },
  "/api/health-log": { GET: healthLogHandler },
  "/api/openapi.json": { GET: openApiHandler },
  "/api/semver": { GET: semverHandler },
});
