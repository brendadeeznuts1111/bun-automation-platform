/**
 * Rate limiter — rolling-window counter backed by SQLite.
 *
 * For each request, we check the rate_limits table for the current
 * time window. If the count exceeds the limit, the request is rejected
 * with 429 Too Many Requests.
 *
 * For distributed deployments, replace this with Redis SETNX + expiry.
 */

import { write } from "../db";

interface RateLimitConfig {
  /** Max requests per window. */
  maxRequests: number;
  /** Window size in seconds. */
  windowSeconds: number;
}

/** Default limits per route prefix. */
const DEFAULTS: Record<string, RateLimitConfig> = {
  "/login": { maxRequests: 5, windowSeconds: 60 },
  "/task": { maxRequests: 20, windowSeconds: 60 },
  "/credentials": { maxRequests: 10, windowSeconds: 60 },
  default: { maxRequests: 100, windowSeconds: 60 },
};

function getConfig(path: string): RateLimitConfig {
  for (const [prefix, cfg] of Object.entries(DEFAULTS)) {
    if (prefix !== "default" && path.startsWith(prefix)) return cfg;
  }
  return DEFAULTS.default!;
}

/**
 * Check and increment the rate limit for a key (usually IP + path prefix + method).
 * Returns true if the request is allowed, false if rate-limited.
 * Atomic upsert with RETURNING count prevents TOCTOU race condition.
 *
 * E11: Include the HTTP method in the key so that GET /task/:id (read-heavy)
 * and POST /task (write-heavy) don't share the same rate limit bucket.
 */
export async function checkRateLimit(
  ip: string,
  path: string,
  method: string,
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const cfg = getConfig(path);
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % cfg.windowSeconds);
  // E11: Include method in the key to separate read and write rate limits
  const key = `${ip}:${method}:${path.split("/").slice(0, 2).join("/")}`;
  const resetAt = (windowStart + cfg.windowSeconds) * 1000;

  const count = await write((db) => {
    const row = db
      .query(
        `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
         RETURNING count;`,
      )
      // JUSTIFIED: bun:sqlite .get() returns unknown; narrowing to the RETURNING row type
      .get(key, windowStart) as { count: number } | null;
    return row?.count ?? 1;
  });

  if (count > cfg.maxRequests) {
    return { allowed: false, remaining: 0, resetAt };
  }

  return { allowed: true, remaining: cfg.maxRequests - count, resetAt };
}

/** Clean up old rate limit entries (call periodically). */
export function cleanupRateLimits(): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
  return write((db) => {
    db.query("DELETE FROM rate_limits WHERE window_start < ?").run(cutoff);
  });
}
