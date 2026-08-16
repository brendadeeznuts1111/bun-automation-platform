/**
 * Cron jobs — scheduled health checks and log rotation.
 *
 * Uses Bun.cron for in-process scheduling — no external cron daemon needed.
 * Ref: node_modules/bun-types/docs/runtime/cron.mdx
 * Ref: https://bun.com/docs/runtime/cron
 */

import { write } from "../db";
import { getPoolStatus } from "../workers/pool";

const AUDIT_RETENTION_DAYS = 30;
const HEALTH_LOG_MAX = 10_000;

/**
 * Register all cron jobs. Called once on server startup.
 */
export function registerCronJobs(): void {
  // Health check every 15 minutes — record pool status to DB
  // Ref: node_modules/bun-types/docs/runtime/cron.mdx#bun-cron-schedule-handler-in-process
  Bun.cron("*/15 * * * *", () => {
    const pool = getPoolStatus();
    const uptime = process.uptime();
    write((db) => {
      db.run(
        `INSERT INTO health_log (ts, pool_status, uptime, bun_version) VALUES (?, ?, ?, ?)`,
        [Date.now(), JSON.stringify(pool), uptime, Bun.version],
      );
      // Cap health_log to last 10k entries
      db.run(`DELETE FROM health_log WHERE id NOT IN (SELECT id FROM health_log ORDER BY ts DESC LIMIT ${HEALTH_LOG_MAX})`);
    });
    console.log(`[cron] health check: ${pool.idle}/${pool.total} workers idle, uptime ${Math.floor(uptime)}s`);
  });

  // Log rotation — daily at 2 AM, purge audit logs older than 30 days
  Bun.cron("0 2 * * *", () => {
    const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 86400_000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    write((db) => {
      const result = db.run(`DELETE FROM audit_log WHERE created_at < ?`, [cutoff]);
      console.log(`[cron] purged ${result.changes} audit log entries older than ${cutoff}`);
    });
    // Vacuum to reclaim space
    write((db) => {
      db.run("VACUUM");
      console.log("[cron] database vacuumed");
    });
  });

  // Next scheduled health check time (for dashboard display)
  const nextHealth = Bun.cron.parse("*/15 * * * *");
  if (nextHealth) {
    console.log(`[cron] next health check at ${nextHealth.toISOString()}`);
  }

  // S3 backup — daily at 3 AM, upload tar bundle to S3 if configured
  // Ref: node_modules/bun-types/docs/runtime/s3.mdx
  Bun.cron("0 3 * * *", async () => {
    const s3Bucket = process.env.S3_BUCKET;
    if (!s3Bucket) return; // S3 not configured — skip silently
    try {
      const { createCompressedExportBundle } = await import("../utils/archive");
      const bundle = await createCompressedExportBundle();
      // JUSTIFIED: dynamic import of bun s3 — only loaded when S3 is configured
      const { s3, write } = await import("bun");
      const file = s3.file(`backups/bun-dev-${bundle.date}.tar.gz`);
      await write(file, bundle.data);
      console.log(`[cron] S3 backup uploaded: ${bundle.date}.tar.gz (${bundle.compressedSize} bytes, ratio: ${((bundle.compressedSize / bundle.originalSize) * 100).toFixed(1)}%)`);
    } catch (err) {
      console.error(`[cron] S3 backup failed: ${err}`);
    }
  });

  const nextBackup = Bun.cron.parse("0 3 * * *");
  if (nextBackup && process.env.S3_BUCKET) {
    console.log(`[cron] next S3 backup at ${nextBackup.toISOString()}`);
  }
}

/**
 * Get recent health log entries for the dashboard.
 */
export function getHealthLog(limit = 20): Array<{
  ts: number;
  pool_status: string;
  uptime: number;
  bun_version: string;
}> {
  // Read from health_log table (created by cron jobs)
  // JUSTIFIED: dynamic import to avoid circular dependency with db/index.ts
  // JUSTIFIED: require() returns any; narrowing to the typed db module
  const { read } = require("../db") as typeof import("../db");
  return read((db) => {
    // Check if health_log table exists
    const tableExists = db.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='health_log'`,
      // JUSTIFIED: bun:sqlite .get() returns unknown; narrowing to the row type
    ).get() as { name: string } | null;
    if (!tableExists) return [];
    return db.query(
      `SELECT ts, pool_status, uptime, bun_version FROM health_log ORDER BY ts DESC LIMIT ?`,
      // JUSTIFIED: bun:sqlite .all() returns unknown[]; narrowing to the row type
    ).all(limit) as Array<{ ts: number; pool_status: string; uptime: number; bun_version: string }>;
  });
}
