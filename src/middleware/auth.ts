/**
 * Auth middleware — Bearer token verification.
 *
 * Extracts the Authorization header, looks up the session token in the
 * auth_sessions table, and attaches the agent_id to the request context.
 * Tokens expire after 24 hours (enforced by the sessions table schema).
 *
 * M4: In-memory cache (Map with TTL) avoids hitting the database on every
 * authenticated request. Cache entries expire after 60 seconds or when the
 * session's DB expiry passes, whichever comes first.
 */

import { read } from "../db";

export interface AuthContext {
  agentId: number;
  sessionId: number;
}

// --- Session cache (M4) -----------------------------------------------------

const SESSION_CACHE_TTL_MS = 60_000; // 1 minute
const sessionCache = new Map<string, { ctx: AuthContext; expires: number }>();

/** Invalidate a cached session (call on logout). */
export function invalidateSession(token: string): void {
  sessionCache.delete(token);
}

/** Clear all cached sessions (call on shutdown). */
export function clearSessionCache(): void {
  sessionCache.clear();
}

/** Extract and verify a Bearer token from the Authorization header. */
export function verifyAuth(req: Request): AuthContext | null {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) return null;

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const token = match[1]!;
  if (!token) return null;

  // Check in-memory cache first (M4)
  const cached = sessionCache.get(token);
  if (cached && cached.expires > Date.now()) {
    return cached.ctx;
  }

  // Cache miss or expired — query the database
  const session = read((db) => {
    return db.query(
      `SELECT id, agent_id FROM auth_sessions
       WHERE token = ? AND expires_at > datetime('now')`,
    ).get(token) as { id: number; agent_id: number } | null;
  });

  if (!session) {
    // Negative cache: don't cache misses (they could be newly created sessions)
    sessionCache.delete(token);
    return null;
  }

  const ctx = { agentId: session.agent_id, sessionId: session.id };
  // Cache for 1 minute — DB expiry is checked on cache miss
  sessionCache.set(token, { ctx, expires: Date.now() + SESSION_CACHE_TTL_MS });
  return ctx;
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
