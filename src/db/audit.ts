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
  return read((db) => {
    if (agentId !== undefined) {
      return db
        .query(
          `SELECT id, agent_id, action, resource, details, ip_address, created_at
           FROM audit_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        )
        .all(agentId, limit, offset) as AuditLogRow[];
    }
    return db
      .query(
        `SELECT id, agent_id, action, resource, details, ip_address, created_at
         FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as AuditLogRow[];
  });
}
