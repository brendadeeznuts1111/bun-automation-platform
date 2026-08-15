import { beforeAll, describe, expect, it } from "bun:test";
import { migrate, read, write } from "../src/db";
import { audit, getAuditLog } from "../src/db/audit";

describe("Database & Audit Layer", () => {
  beforeAll(() => {
    migrate();
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
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0]?.action).toBe("test_audit_event");
    expect(logs[0]?.agent_id).toBe(uniqueAgentId);
  });
});
