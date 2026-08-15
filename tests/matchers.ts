/**
 * Custom bun:test matchers — registered via expect.extend().
 *
 * Loaded by tests/setup.ts preload so matchers are available in every test
 * file without per-file imports.
 *
 * API reference: https://bun.com/reference/bun/test/Expect/extend
 * Each matcher is (actual, ...args) => { pass: boolean, message: () => string }
 */

import { expect } from "bun:test";
import type { AuditLogRow } from "../src/types/models";

// TypeScript declaration merging — makes toBeValidAuditEntry() type-checked.
// Must be in a .ts file (not .d.ts) for tsc to pick it up with this project's
// include patterns.
declare module "bun:test" {
  interface Matchers<T> {
    toBeValidAuditEntry(): void;
  }
  interface AsymmetricMatchers {
    toBeValidAuditEntry(): void;
  }
}

/**
 * Assert an object is a valid audit_log row: has the AuditLogRow shape with
 * correct types, a positive integer id, a non-empty action, and an ISO-8601
 * created_at timestamp.
 *
 * @example
 *   expect(logs[0]).toBeValidAuditEntry();
 *   expect(row).not.toBeValidAuditEntry(); // negation
 *   expect(row).toEqual(expect.toBeValidAuditEntry()); // asymmetric
 */
expect.extend({
  toBeValidAuditEntry(actual: unknown) {
    const { printReceived } = this.utils;

    if (actual === null || typeof actual !== "object") {
      return {
        pass: false,
        message: () =>
          `expected ${printReceived(actual)} to be a valid audit entry (object)`,
      };
    }

    // JUSTIFIED: narrowing unknown to Partial<AuditLogRow> for matcher validation
    const row = actual as Partial<AuditLogRow>;
    const errors: string[] = [];

    if (typeof row.id !== "number" || !Number.isInteger(row.id) || row.id <= 0) {
      errors.push(`id should be a positive integer, got ${printReceived(row.id)}`);
    }
    if (row.agent_id !== null && (typeof row.agent_id !== "number" || !Number.isInteger(row.agent_id))) {
      errors.push(`agent_id should be an integer or null, got ${printReceived(row.agent_id)}`);
    }
    if (typeof row.action !== "string" || row.action.length === 0) {
      errors.push(`action should be a non-empty string, got ${printReceived(row.action)}`);
    }
    if (row.resource !== null && typeof row.resource !== "string") {
      errors.push(`resource should be a string or null, got ${printReceived(row.resource)}`);
    }
    if (row.details !== null && typeof row.details !== "string") {
      errors.push(`details should be a string or null, got ${printReceived(row.details)}`);
    }
    if (row.ip_address !== null && typeof row.ip_address !== "string") {
      errors.push(`ip_address should be a string or null, got ${printReceived(row.ip_address)}`);
    }
    if (typeof row.created_at !== "string" || Number.isNaN(Date.parse(row.created_at))) {
      errors.push(`created_at should be an ISO-8601 string, got ${printReceived(row.created_at)}`);
    }

    const pass = errors.length === 0;
    return {
      pass,
      message: () =>
        pass
          ? `expected ${printReceived(actual)} not to be a valid audit entry`
          : `expected ${printReceived(actual)} to be a valid audit entry:\n  - ${errors.join("\n  - ")}`,
    };
  },
});
