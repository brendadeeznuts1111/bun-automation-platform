/**
 * Circuit breaker — tracks failures per target site.
 *
 * After N consecutive failures in a time window, the circuit "trips"
 * and subsequent requests to that site are short-circuited with a 503.
 * After a cooldown period, the circuit enters "half-open" state and
 * allows one probe request; if it succeeds, the circuit resets.
 */

import { read, write } from "../db";
import { CircuitStatusRow } from "../types/models";

const FAILURE_THRESHOLD = parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD ?? "5", 10);
const COOLDOWN_MS = parseInt(process.env.CIRCUIT_BREAKER_COOLDOWN_MS ?? "300000", 10); // 5 min

type CircuitState = "closed" | "open" | "half-open";

interface CircuitStatus {
  state: CircuitState;
  failures: number;
  trippedAt: number | null;
}

function parseSqliteDate(dateStr: string): number {
  if (dateStr.endsWith("Z")) return new Date(dateStr).getTime();
  return new Date(dateStr.replace(" ", "T") + "Z").getTime();
}

/** Get the current state of a site's circuit breaker. */
export function getCircuitStatus(site: string): CircuitStatus {
  const row = read((db) => {
    return db.query("SELECT failures, tripped_at FROM circuit_breakers WHERE site = ?").as(CircuitStatusRow).get(site);
  });

  if (!row || row.failures < FAILURE_THRESHOLD) {
    return { state: "closed", failures: row?.failures ?? 0, trippedAt: null };
  }

  if (!row.tripped_at) {
    return { state: "closed", failures: row.failures, trippedAt: null };
  }

  const trippedAt = parseSqliteDate(row.tripped_at);
  const elapsed = Date.now() - trippedAt;

  if (elapsed >= COOLDOWN_MS) {
    return { state: "half-open", failures: row.failures, trippedAt };
  }

  return { state: "open", failures: row.failures, trippedAt };
}

/** Record a failure for a site. Trips the circuit if threshold reached. */
export function recordFailure(site: string): Promise<void> {
  return write((db) => {
    // D5: Use parameter binding instead of string interpolation for FAILURE_THRESHOLD
    db.query(
      `INSERT INTO circuit_breakers (site, failures, tripped_at, last_failure)
       VALUES (?, 1, NULL, datetime('now'))
       ON CONFLICT(site) DO UPDATE SET
         failures = failures + 1,
         last_failure = datetime('now'),
         tripped_at = CASE
           WHEN circuit_breakers.failures + 1 >= ? AND tripped_at IS NULL
           THEN datetime('now')
           ELSE tripped_at
         END`,
    ).run(site, FAILURE_THRESHOLD);
  });
}

/** Record a success — resets the circuit for the site. */
export function recordSuccess(site: string): Promise<void> {
  return write((db) => {
    db.query(
      `INSERT INTO circuit_breakers (site, failures, tripped_at, last_failure)
       VALUES (?, 0, NULL, NULL)
       ON CONFLICT(site) DO UPDATE SET
         failures = 0,
         tripped_at = NULL,
         last_failure = NULL`,
    ).run(site);
  });
}

/** Check if a request to the given site is allowed. */
export function isAllowed(site: string): boolean {
  const status = getCircuitStatus(site);
  return status.state !== "open";
}

/** Get the Retry-After header value (seconds) for a tripped circuit. */
export function retryAfterSeconds(site: string): number {
  const status = getCircuitStatus(site);
  if (status.state !== "open" || status.trippedAt === null) return 0;
  const remaining = COOLDOWN_MS - (Date.now() - status.trippedAt);
  return Math.max(1, Math.ceil(remaining / 1000));
}
