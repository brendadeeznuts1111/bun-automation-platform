/**
 * Audit log — records state-changing actions for accountability.
 *
 * Uses the write mutex from the DB layer to serialize inserts.
 * Called from middleware after successful state changes.
 */

import { write, read } from "../db";

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
): { id: number; agent_id: number | null; action: string; resource: string | null; details: string | null; ip_address: string | null; created_at: string }[] {
  return read((db) => {
    if (agentId) {
      return db.query(
        `SELECT * FROM audit_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ).all(agentId, limit, offset) as any;
    }
    return db.query(
      `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).all(limit, offset) as any;
  });
}
