import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { migrate, read, write } from "../src/db";
import { audit, getAuditLog } from "../src/db/audit";

describe("Database & Audit Layer", () => {
  beforeAll(() => {
    migrate();
  });

  // Clean test-generated rows before each test so tests don't inherit
  // prior test state. Uses unique action/site prefixes as a safety net,
  // but this ensures exact counts for assertions.
  beforeEach(() => {
    write((db) => {
      db.exec("DELETE FROM audit_log WHERE action LIKE 'test_%' OR action LIKE 'zero-agent-%' OR action LIKE 'other-agent-%'");
      db.exec("DELETE FROM circuit_breakers WHERE site LIKE 'db-mutex-%'");
    });
  });

  it("performs concurrent reads via read pool", async () => {
    const promises = Array.from({ length: 8 }, (_, i) =>
      Promise.resolve().then(() =>
        read((db) => {
          const row = db.query("SELECT 1 as val").get() as { val: number };
          return row.val + i;
        }),
      ),
    );

    const results = await Promise.all(promises);
    expect(results.length).toBe(8);
    expect(results[0]).toBe(1);
    expect(results[7]).toBe(8);
  });

  it("serializes writes atomically through write mutex queue", async () => {
    const site = `db-mutex-${Date.now()}`;

    const p1 = write((db) => {
      db.query("INSERT INTO circuit_breakers (site, failures) VALUES (?, 1)").run(`${site}-1`);
      return 1;
    });

    const p2 = write((db) => {
      db.query("INSERT INTO circuit_breakers (site, failures) VALUES (?, 2)").run(`${site}-2`);
      return 2;
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
  });

  it("records and queries audit log entries with agent filtering", async () => {
    const uniqueAgentId = Math.floor(Date.now() % 100000);

    await audit({
      agent_id: uniqueAgentId,
      action: "test_audit_event",
      resource: "test:resource",
      ip_address: "127.0.0.1",
    });

    const logs = getAuditLog(10, 0, uniqueAgentId);
    expect(logs.length).toBe(1);

    // Every returned row must be a valid audit entry AND match the filter.
    for (const row of logs) {
      expect(row).toBeValidAuditEntry();
      expect(row.agent_id).toBe(uniqueAgentId);
    }
    expect(logs[0]?.action).toBe("test_audit_event");
  });

  it("filters by agent_id=0 without returning all rows (regression)", async () => {
    // getAuditLog previously used `if (agentId)` which is falsy for 0,
    // skipping the filter and returning all logs. agent_id=0 is a valid
    // value (audit_log.agent_id is a nullable INTEGER, no FK constraint).
    const zeroAction = `zero-agent-${Date.now()}`;
    const otherAction = `other-agent-${Date.now()}`;

    await audit({ agent_id: 0, action: zeroAction });
    await audit({ agent_id: 99999, action: otherAction });

    const zeroLogs = getAuditLog(50, 0, 0);
    expect(zeroLogs.length).toBe(1);
    for (const row of zeroLogs) {
      expect(row).toBeValidAuditEntry();
      expect(row.agent_id).toBe(0);
    }

    // The other agent's entry must NOT appear when filtering for agent 0
    expect(zeroLogs.some((r) => r.action === otherAction)).toBe(false);
  });
});
