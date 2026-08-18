// Auth, session, screenshot, and audit routes.
//
// Ref: https://bun.com/docs/runtime/http/routing

import type { BunRequest } from "bun";
import { read, write } from "../db";
import { audit, getAuditLog, onAuditEvent } from "../db/audit";
import { generateCsrfToken } from "../middleware/csrf";
import { AgentLoginRow, ScreenshotPathRow, SessionListRow } from "../types/models";
import { serveScreenshot } from "../utils/image";
import { log } from "../utils/log";
import { router } from "./router";
import { errorResponse, getClientIP, json, withAuth, withMiddleware } from "./shared";

// --- Startup-dependent values (set by server.ts) ---------------------------

let dummyPasswordHash = "";

/** Called by server.ts to provide the pre-computed dummy hash for timing oracle mitigation. */
export function setDummyPasswordHash(hash: string): void {
  dummyPasswordHash = hash;
}

// --- Handlers ---------------------------------------------------------------

const loginHandler = withMiddleware<"">(async (req) => {
  try {
    // JUSTIFIED: req.json() returns unknown; narrowing to the login body shape
    const body = (await req.json()) as { username: string; password: string };

    if (!body.username || !body.password) {
      return errorResponse("username and password required", 400);
    }

    const ip = getClientIP(req);
    const agent = read((db) => {
      return db
        .query("SELECT id, username, password FROM agents WHERE username = ?")
        .as(AgentLoginRow)
        .get(body.username);
    });

    if (!agent) {
      // E2: Timing oracle — verify against a dummy hash so non-existent users
      // take the same time as wrong-password attempts.
      await Bun.password.verify(body.password, dummyPasswordHash);
      await audit({ action: "login_failed", resource: body.username, ip_address: ip });
      return errorResponse("invalid credentials", 401);
    }

    const valid = await Bun.password.verify(body.password, agent.password);
    if (!valid) {
      await audit({ action: "login_failed", resource: body.username, ip_address: ip });
      return errorResponse("invalid credentials", 401);
    }

    await audit({ agent_id: agent.id, action: "login_success", ip_address: ip });

    const authToken = crypto.randomUUID();

    const { csrfToken } = await write((db) => {
      const createSession = db.transaction(() => {
        const result = db
          .query(
            `INSERT INTO auth_sessions (agent_id, token, csrf_token)
           VALUES (?, ?, '')`,
          )
          .run(agent.id, authToken);
        const sid = Number(result.lastInsertRowid);

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
    if (err instanceof SyntaxError) {
      return errorResponse("invalid request body", 400);
    }
    log("server", "error", "login error", err);
    return errorResponse("internal server error", 500);
  }
});

const listSessionsHandler = withAuth<"">((req, ctx) => {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const includeExpired = url.searchParams.get("include_expired") === "true";

  const sessions = read((db) => {
    if (includeExpired) {
      return db
        .query(
          `SELECT s.id, s.task_id, s.screenshot_path, s.screenshot_color, s.expires_at, s.last_healthy, s.created_at
         FROM sessions s JOIN tasks t ON s.task_id = t.id
         WHERE t.agent_id = ?
         ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
        )
        .as(SessionListRow)
        .all(ctx.agentId, limit, offset);
    }
    return db
      .query(
        `SELECT s.id, s.task_id, s.screenshot_path, s.screenshot_color, s.expires_at, s.last_healthy, s.created_at
       FROM sessions s JOIN tasks t ON s.task_id = t.id
       WHERE t.agent_id = ? AND (s.expires_at IS NULL OR s.expires_at > datetime('now'))
       ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
      )
      .as(SessionListRow)
      .all(ctx.agentId, limit, offset);
  });

  return json({ sessions, limit, offset });
});

const sessionsJsonlHandler = withAuth<"">((req, ctx) => {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const includeExpired = url.searchParams.get("include_expired") === "true";
  const sessions = read((db) => {
    if (includeExpired) {
      return db
        .query(
          `SELECT s.id, s.task_id, s.screenshot_path, s.screenshot_color, s.expires_at, s.last_healthy, s.created_at
         FROM sessions s JOIN tasks t ON s.task_id = t.id
         WHERE t.agent_id = ?
         ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
        )
        .as(SessionListRow)
        .all(ctx.agentId, limit, offset);
    }
    return db
      .query(
        `SELECT s.id, s.task_id, s.screenshot_path, s.screenshot_color, s.expires_at, s.last_healthy, s.created_at
       FROM sessions s JOIN tasks t ON s.task_id = t.id
       WHERE t.agent_id = ? AND (s.expires_at IS NULL OR s.expires_at > datetime('now'))
       ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
      )
      .as(SessionListRow)
      .all(ctx.agentId, limit, offset);
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
  const session = read((db) => {
    return db
      .query(
        `SELECT s.screenshot_path FROM sessions s
       JOIN tasks t ON s.task_id = t.id
       WHERE s.id = ? AND t.agent_id = ?`,
      )
      .as(ScreenshotPathRow)
      .get(sessionId, ctx.agentId);
  });

  if (!session) return errorResponse("session not found", 404);
  if (!session.screenshot_path) return errorResponse("no screenshot for this session", 404);

  const url = new URL(req.url);
  const width = url.searchParams.get("w") ? parseInt(url.searchParams.get("w")!, 10) : undefined;
  const formatParam = url.searchParams.get("format");
  const format: "webp" | "jpeg" | "png" = formatParam === "jpeg" || formatParam === "png" ? formatParam : "webp";

  try {
    return await serveScreenshot(session.screenshot_path, width, format);
  } catch (err) {
    log("server", "error", "serveScreenshot error", err);
    return errorResponse("screenshot unavailable", 404);
  }
});

const auditHandler = withAuth<"">((req, ctx) => {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
  const offset = parseInt(url.searchParams.get("offset") ?? "0", 10);
  const agentId = ctx.agentId;

  const logs = getAuditLog(limit, offset, agentId);
  return json({ logs, limit, offset });
});

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

const auditStreamHandler = withAuth<"">((req: BunRequest<"">): Response => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(": connected\n\n"));
      const unsubscribe = onAuditEvent((entry) => {
        const data = `data: ${JSON.stringify(entry)}\n\n`;
        try {
          controller.enqueue(new TextEncoder().encode(data));
        } catch {
          unsubscribe();
        }
      });
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
        } catch {
          unsubscribe();
          clearInterval(heartbeat);
        }
      }, 30_000);
      req.signal?.addEventListener("abort", () => {
        unsubscribe();
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

// --- Route exports ---------------------------------------------------------

export const authRoutes = router({
  "/login": { POST: loginHandler },
  "/sessions": { GET: listSessionsHandler },
  "/api/sessions.jsonl": { GET: sessionsJsonlHandler },
  "/screenshot/:id": { GET: getScreenshotHandler },
  "/audit": { GET: auditHandler },
  "/api/audit.jsonl": { GET: auditJsonlHandler },
  "/api/audit/stream": { GET: auditStreamHandler },
});
