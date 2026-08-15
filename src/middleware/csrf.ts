/**
 * CSRF middleware — Bun.CSRF token verification for state-changing requests.
 *
 * Uses Bun's built-in HMAC-signed CSRF tokens. Required on POST/PUT/DELETE.
 *
 * IMPORTANT: Bun.CSRF (v1.3.14) does NOT support sessionId binding.
 * CSRFGenerateOptions only has: expiresIn, encoding, algorithm.
 * CSRFVerifyOptions only has: secret, encoding, algorithm, maxAge.
 * (Verified against node_modules/bun-types/bun.d.ts)
 *
 * To prevent cross-user CSRF token replay, we manually bind the session ID
 * into the token by HMAC-ing it into the secret. This way a token generated
 * for session A won't verify against session B's secret.
 *
 * Ref: node_modules/bun-types/docs/runtime/csrf.mdx
 * Ref: node_modules/bun-types/bun.d.ts (CSRFGenerateOptions, CSRFVerifyOptions)
 */

// E1: In production, require CSRF_SECRET to be set. A hardcoded default
// would let attackers forge CSRF tokens signed with a publicly known secret.
const CSRF_SECRET = process.env.CSRF_SECRET ?? "dev-csrf-secret-change-in-prod";
if (process.env.NODE_ENV === "production" && !process.env.CSRF_SECRET) {
  console.error("[csrf] FATAL: CSRF_SECRET environment variable is not set in production.");
  console.error("[csrf] Refusing to start with a known default secret. Set CSRF_SECRET to a random string.");
  process.exit(1);
}

/**
 * Derive a per-session secret by HMAC-ing the session ID into the base secret.
 * This binds CSRF tokens to a specific session without relying on a Bun API
 * feature that doesn't exist. Uses Bun's built-in Bun.password for key derivation.
 */
function deriveSessionSecret(sessionId: string): string {
  // Use Web Crypto API (available in Bun) to HMAC the session ID into the secret
  const key = new Bun.CryptoHasher("sha256");
  key.update(CSRF_SECRET);
  key.update(":");
  key.update(sessionId);
  return key.digest("hex");
}

/** Generate a CSRF token bound to a session ID. */
export function generateCsrfToken(sessionId: string): string {
  const sessionSecret = deriveSessionSecret(sessionId);
  return Bun.CSRF.generate(sessionSecret);
}

/** Verify a CSRF token against the session ID. */
export function verifyCsrfToken(token: string, sessionId: string): boolean {
  const sessionSecret = deriveSessionSecret(sessionId);
  return Bun.CSRF.verify(token, { secret: sessionSecret });
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
