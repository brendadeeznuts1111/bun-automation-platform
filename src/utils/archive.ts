/**
 * Archive utility — tar export bundles via Bun.Archive.
 *
 * Bundles JSONL exports + manifest into a single .tar download.
 * Ref: node_modules/bun-types/docs/runtime/archive.mdx
 * Ref: https://bun.com/docs/runtime/archive
 */

import { read } from "../db";

/**
 * Generate a tar archive containing all JSONL exports + manifest.
 * Returns the archive as a Bun.Archive object that can be written or streamed.
 */
export function createExportBundle(): {
  archive: unknown;
  date: string;
  files: string[];
} {
  const date = new Date().toISOString().slice(0, 10);

  // Collect all JSONL exports from the database
  const tasks = read((db) => {
    return db.query("SELECT * FROM tasks").all();
  });
  const sessions = read((db) => {
    return db.query("SELECT * FROM sessions").all();
  });
  const auditLog = read((db) => {
    return db.query("SELECT * FROM audit_log ORDER BY created_at DESC").all();
  });

  const files: Record<string, string> = {
    [`tasks-${date}.jsonl`]: tasks.map((t) => JSON.stringify(t)).join("\n"),
    [`sessions-${date}.jsonl`]: sessions.map((s) => JSON.stringify(s)).join("\n"),
    [`audit-${date}.jsonl`]: auditLog.map((a) => JSON.stringify(a)).join("\n"),
    [`manifest-${date}.json`]: JSON.stringify({
      exported_at: new Date().toISOString(),
      bun_version: Bun.version,
      task_count: tasks.length,
      session_count: sessions.length,
      audit_count: auditLog.length,
    }, null, 2),
  };

  // JUSTIFIED: Bun.Archive constructor is typed but the return type
  // varies by platform; we treat it as unknown for safe transport.
  // Ref: node_modules/bun-types/docs/runtime/archive.mdx#creating-archives
  const archive = new Bun.Archive(files);
  return { archive, date, files: Object.keys(files) };
}
