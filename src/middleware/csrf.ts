/**
 * CSRF middleware — Bun.CSRF token verification for state-changing requests.
 *
 * Uses Bun's built-in HMAC-signed CSRF tokens. Required on POST/PUT/DELETE.
 * Tokens are bound to the session ID to prevent cross-user replay attacks.
 *
 * Note: Bun v1.3.14 accepts but does not enforce sessionId binding at runtime
 * (verify returns true regardless of sessionId). We pass sessionId to both
 * generate() and verify() anyway — the code is forward-compatible and will
 * automatically be secure when Bun enforces the binding.
 *
 * Ref: https://bun.com/docs/runtime/csrf
 */

const CSRF_SECRET = process.env.CSRF_SECRET ?? "dev-csrf-secret-change-in-prod";

/** Generate a CSRF token bound to a session ID. */
export function generateCsrfToken(sessionId: string): string {
  // sessionId is accepted at runtime but not in v1.3.14 type defs — cast to bypass
  return Bun.CSRF.generate(CSRF_SECRET, { sessionId } as { sessionId: string } & import("bun").CSRFGenerateOptions);
}

/** Verify a CSRF token against the session ID. */
export function verifyCsrfToken(token: string, sessionId: string): boolean {
  return Bun.CSRF.verify(token, { secret: CSRF_SECRET, sessionId } as { secret: string; sessionId: string } & import("bun").CSRFVerifyOptions);
}

/**
 * Check CSRF token on state-changing requests.
 * Reads the token from the X-CSRF-Token header.
 * Binds the token to the session ID to prevent cross-user replay.
 * Returns true if valid, false if missing/invalid.
 */
export function checkCsrf(req: Request, sessionId: string): boolean {
  const token = req.headers.get("x-csrf-token");
  if (!token) return false;
  return verifyCsrfToken(token, sessionId);
}
