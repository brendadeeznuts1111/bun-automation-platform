/**
 * CSRF middleware — Bun.CSRF token verification for state-changing requests.
 *
 * Uses Bun's built-in HMAC-signed CSRF tokens. Required on POST/PUT/DELETE.
 *
 * Note: Bun v1.3.14's Bun.CSRF accepts but does not enforce sessionId binding
 * (verify returns true regardless of sessionId). We use the token alone for now.
 * When Bun enforces sessionId, update generate/verify to pass it.
 *
 * Ref: https://bun.com/docs/runtime/csrf
 */

const CSRF_SECRET = process.env.CSRF_SECRET ?? "dev-csrf-secret-change-in-prod";

/** Generate a CSRF token. */
export function generateCsrfToken(): string {
  return Bun.CSRF.generate(CSRF_SECRET);
}

/** Verify a CSRF token. */
export function verifyCsrfToken(token: string): boolean {
  return Bun.CSRF.verify(token, { secret: CSRF_SECRET });
}

/**
 * Check CSRF token on state-changing requests.
 * Reads the token from the X-CSRF-Token header.
 * Returns true if valid, false if missing/invalid.
 */
export function checkCsrf(req: Request): boolean {
  const token = req.headers.get("x-csrf-token");
  if (!token) return false;
  return verifyCsrfToken(token);
}
