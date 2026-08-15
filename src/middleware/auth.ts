/**
 * Auth middleware — Bearer token verification.
 *
 * Extracts the Authorization header, looks up the session token in the
 * sessions table, and attaches the agent_id to the request context.
 * Tokens expire after 24 hours (enforced by the sessions table schema).
 */

import { read } from "../db";

export interface AuthContext {
  agentId: number;
  sessionId: number;
}

/** Extract and verify a Bearer token from the Authorization header. */
export function verifyAuth(req: Request): AuthContext | null {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return null;

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const token = match[1]!;
  if (!token) return null;

  const session = read((db) => {
    return db.query(
      `SELECT id, agent_id FROM auth_sessions
       WHERE token = ? AND expires_at > datetime('now')`,
    ).get(token) as { id: number; agent_id: number } | null;
  });

  if (!session) return null;

  return { agentId: session.agent_id, sessionId: session.id };
}

/** Require auth — returns AuthContext or throws a 401 Response. */
export function requireAuth(req: Request): AuthContext | Response {
  const ctx = verifyAuth(req);
  if (!ctx) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return ctx;
}

/** Check if a request has valid auth (boolean version for middleware). */
export function isAuthenticated(req: Request): boolean {
  return verifyAuth(req) !== null;
}
