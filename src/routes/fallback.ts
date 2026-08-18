// Fallback fetch handler — CORS preflight, WebSocket upgrade, 404.
//
// Used as the `fetch` handler in Bun.serve() for unmatched routes.
// Ref: https://bun.com/docs/runtime/http/routing#fetch-request-handler

import type { Server } from "bun";
import { handlePreflight, withCors } from "../middleware/cors";
import { errorResponse } from "./shared";

export interface FallbackConfig {
  ENABLE_WEBSOCKET: boolean;
}

let config: FallbackConfig = { ENABLE_WEBSOCKET: false };

/** Called by server.ts to pass feature flags. */
export function setFallbackConfig(cfg: FallbackConfig): void {
  config = cfg;
}

/**
 * Fallback fetch handler for unmatched routes.
 * Handles CORS preflight (OPTIONS), WebSocket upgrade, and 404s.
 */
export function fallbackFetch(req: Request, server: Server<unknown>): Response | undefined | Promise<Response> {
  // CORS preflight for any route
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  // C7: WebSocket upgrade for /ws/task/:id and /ws/metrics
  if (config.ENABLE_WEBSOCKET) {
    const url = new URL(req.url);
    const wsMatch = url.pathname.match(/^\/ws\/task\/(\d+)$/);
    if (wsMatch && wsMatch[1]) {
      const taskId = parseInt(wsMatch[1], 10);
      const upgraded = server.upgrade(req, { data: { taskId, channel: "task" } });
      return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    }
    // Live metrics streaming — /ws/metrics
    if (url.pathname === "/ws/metrics") {
      const upgraded = server.upgrade(req, { data: { taskId: 0, channel: "metrics" } });
      return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    }
  }

  return withCors(req, errorResponse("not found", 404));
}
