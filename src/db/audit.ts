/**
 * Audit log — records state-changing actions for accountability.
 *
 * Uses the write mutex from the DB layer to serialize inserts.
 * Called from middleware after successful state changes.
 */

import { write, read } from "../db";
import type { AuditLogRow } from "../types/models";

export interface AuditEntry {
  agent_id?: number;
  action: string;
  resource?: string;
  details?: string;
  ip_address?: string;
}

export function audit(entry: AuditEntry): Promise<void> {
  return write((db) => {
    db.query(
      `INSERT INTO audit_log (agent_id, action, resource, details, ip_address)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      entry.agent_id ?? null,
      entry.action,
      entry.resource ?? null,
      entry.details ?? null,
      entry.ip_address ?? null,
    );
  });
}

/** Query audit log with pagination. */
export function getAuditLog(
  limit = 50,
  offset = 0,
  agentId?: number,
): AuditLogRow[] {
  // D6: Single parameterized query instead of two variants — avoids filling
  // the db.query() statement cache (default size: 20).
  return read((db) => {
    return db
      .query(
        `SELECT id, agent_id, action, resource, details, ip_address, created_at
         FROM audit_log WHERE (? IS NULL OR agent_id = ?)
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      // JUSTIFIED: bun:sqlite .all() returns unknown[]; narrowing to AuditLogRow[]
      .all(agentId ?? null, agentId ?? null, limit, offset) as AuditLogRow[];
  });
}
