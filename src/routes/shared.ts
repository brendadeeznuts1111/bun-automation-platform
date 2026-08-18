// Shared infrastructure for route modules.
//
// Extracted from src/server.ts so route handlers in src/routes/*.ts can
// import the middleware wrappers, helpers, and config without pulling in
// the entire server file.
//
// Ref: https://bun.com/docs/runtime/http/routing

import type { BunRequest } from "bun";
import { type AuthContext, verifyAuth } from "../middleware/auth";
import { withCors } from "../middleware/cors";
import { checkCsrf } from "../middleware/csrf";
import { checkRateLimit } from "../middleware/rate-limit";
import { log } from "../utils/log";

// --- Config ----------------------------------------------------------------

export const MAX_BODY_BYTES = 1_048_576;

// --- Helpers ---------------------------------------------------------------

/**
 * Extract the client IP from the request.
 * Trust order: cf-connecting-ip → x-forwarded-for → unknown.
 * Set TRUST_PROXY_HEADERS=false to only use the socket peer address.
 */
export function getClientIP(req: Request): string {
  const trustProxy = process.env.TRUST_PROXY_HEADERS !== "false";
  if (trustProxy) {
    return (
      req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown"
    );
  }
  return "unknown";
}

export function json(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  if (extraHeaders) {
    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
    return Response.json(data, { status, headers });
  }
  return Response.json(data, { status });
}

export function errorResponse(msg: string, status: number): Response {
  return Response.json({ error: msg }, { status });
}

// --- Middleware wrappers ---------------------------------------------------

export type RouteHandler<T extends string> = (req: BunRequest<T>) => Response | Promise<Response>;

/**
 * Base middleware: rate limiting + CORS + request size limit + structured logging.
 * Applied to all routes.
 */
export function withMiddleware<T extends string>(handler: RouteHandler<T>): RouteHandler<T> {
  return async (req) => {
    const ip = getClientIP(req);
    const path = new URL(req.url).pathname;

    const traceId = Bun.CryptoHasher.hash("sha256", `${Date.now()}-${Math.random()}`, "hex").slice(0, 16);

    const rl = await checkRateLimit(ip, path, req.method);
    if (!rl.allowed) {
      return withCors(req, errorResponse("Too Many Requests", 429));
    }

    const contentLength = req.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
      return withCors(req, errorResponse("request body too large", 413));
    }

    const start = performance.now();
    const res = await handler(req);
    const duration = (performance.now() - start).toFixed(2);

    log("server", "info", `${req.method} ${path}`, { traceId, ip, status: res.status, duration: `${duration}ms` });

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
export function withAuth<T extends string>(
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
export function withCsrf<T extends string>(
  handler: (req: BunRequest<T>, ctx: AuthContext) => Response | Promise<Response>,
): RouteHandler<T> {
  return withAuth(async (req, ctx) => {
    if (!checkCsrf(req, String(ctx.sessionId))) {
      return errorResponse("invalid csrf token", 403);
    }
    return handler(req, ctx);
  });
}
