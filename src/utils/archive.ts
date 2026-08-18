/**
 * Archive utility — tar export bundles via Bun.Archive.
 *
 * Bundles JSONL exports + manifest into a single .tar download.
 * Supports gzip compression via Bun.deflateSync.
 * Ref: node_modules/bun-types/docs/runtime/archive.mdx
 * Ref: https://bun.com/docs/runtime/archive
 */

import { read } from "../db";
import { AuditLogRow, SessionRow, TaskRow } from "../types/models";

/**
 * Generate a tar archive containing all JSONL exports + manifest.
 * Returns the archive as a Bun.Archive object that can be written or streamed.
 */
export function createExportBundle(): {
  archive: unknown;
  date: string;
  files: string[];
  compressed: boolean;
} {
  const date = new Date().toISOString().slice(0, 10);

  // Collect all JSONL exports from the database
  const tasks = read((db) => {
    return db.query("SELECT * FROM tasks").as(TaskRow).all();
  });
  const sessions = read((db) => {
    return db.query("SELECT * FROM sessions").as(SessionRow).all();
  });
  const auditLog = read((db) => {
    return db.query("SELECT * FROM audit_log ORDER BY created_at DESC").as(AuditLogRow).all();
  });

  const files: Record<string, string> = {
    [`tasks-${date}.jsonl`]: tasks.map((t) => JSON.stringify(t)).join("\n"),
    [`sessions-${date}.jsonl`]: sessions.map((s) => JSON.stringify(s)).join("\n"),
    [`audit-${date}.jsonl`]: auditLog.map((a) => JSON.stringify(a)).join("\n"),
    [`manifest-${date}.json`]: JSON.stringify(
      {
        exported_at: new Date().toISOString(),
        bun_version: Bun.version,
        task_count: tasks.length,
        session_count: sessions.length,
        audit_count: auditLog.length,
      },
      null,
      2,
    ),
  };

  // JUSTIFIED: Bun.Archive constructor is typed but the return type
  // varies by platform; we treat it as unknown for safe transport.
  // Ref: node_modules/bun-types/docs/runtime/archive.mdx#creating-archives
  const archive = new Bun.Archive(files);
  return { archive, date, files: Object.keys(files), compressed: false };
}

/**
 * Generate a gzip-compressed tar archive.
 * Uses Bun.Archive's native compress:"gzip" option — no external gzip dependency.
 * Ref: node_modules/bun-types/docs/runtime/archive.mdx#getting-archive-bytes
 */
export async function createCompressedExportBundle(): Promise<{
  data: Uint8Array;
  date: string;
  files: string[];
  compressed: boolean;
  originalSize: number;
  compressedSize: number;
}> {
  const date = new Date().toISOString().slice(0, 10);

  // Collect all JSONL exports from the database
  const tasks = read((db) => db.query("SELECT * FROM tasks").as(TaskRow).all());
  const sessions = read((db) => db.query("SELECT * FROM sessions").as(SessionRow).all());
  const auditLog = read((db) => db.query("SELECT * FROM audit_log ORDER BY created_at DESC").as(AuditLogRow).all());

  const files: Record<string, string> = {
    [`tasks-${date}.jsonl`]: tasks.map((t) => JSON.stringify(t)).join("\n"),
    [`sessions-${date}.jsonl`]: sessions.map((s) => JSON.stringify(s)).join("\n"),
    [`audit-${date}.jsonl`]: auditLog.map((a) => JSON.stringify(a)).join("\n"),
    [`manifest-${date}.json`]: JSON.stringify(
      {
        exported_at: new Date().toISOString(),
        bun_version: Bun.version,
        task_count: tasks.length,
        session_count: sessions.length,
        audit_count: auditLog.length,
      },
      null,
      2,
    ),
  };

  // Uncompressed archive for size comparison
  // JUSTIFIED: Bun.Archive constructor per archive.mdx — returns Archive object
  const uncompressedArchive = new Bun.Archive(files);
  // JUSTIFIED: .bytes() returns Uint8Array per archive.mdx#getting-archive-bytes
  const originalBytes = await (uncompressedArchive as unknown as { bytes: () => Promise<Uint8Array> }).bytes();
  const originalSize = originalBytes.byteLength;

  // Compressed archive — Bun.Archive supports compress:"gzip" natively
  // Ref: node_modules/bun-types/docs/runtime/archive.mdx#writing-archives-to-disk
  // JUSTIFIED: compress option per archive.mdx — not in all bun-types versions
  const gzippedArchive = new Bun.Archive(files, { compress: "gzip" } as unknown as ConstructorParameters<
    typeof Bun.Archive
  >[1]);
  // JUSTIFIED: .bytes() returns Uint8Array per archive.mdx#getting-archive-bytes
  const compressedBytes = await (gzippedArchive as unknown as { bytes: () => Promise<Uint8Array> }).bytes();

  return {
    data: compressedBytes,
    date,
    files: Object.keys(files),
    compressed: true,
    originalSize,
    compressedSize: compressedBytes.byteLength,
  };
}
