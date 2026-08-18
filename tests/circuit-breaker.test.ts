import { beforeAll, describe, expect, test } from "bun:test";
import { migrate } from "../src/db";
import {
  getCircuitStatus,
  isAllowed,
  recordFailure,
  recordSuccess,
  retryAfterSeconds,
} from "../src/utils/circuit-breaker";

describe("circuit-breaker", () => {
  beforeAll(() => {
    migrate();
  });

  test("starts in closed state with zero failures", async () => {
    const site = `test-init-${Date.now()}.example.com`;
    await recordSuccess(site);
    const status = getCircuitStatus(site);
    expect(status.state).toBe("closed");
    expect(status.failures).toBe(0);
    expect(isAllowed(site)).toBe(true);
  });

  // Parametrized: trips at exactly the threshold, and stays open beyond it.
  test.each([
    { failures: 5, desc: "trips at threshold (5)" },
    { failures: 10, desc: "stays open beyond threshold (10)" },
  ])("$desc", async ({ failures }) => {
    const site = `test-fail-${failures}-${Date.now()}.example.com`;
    for (let i = 0; i < failures; i++) {
      await recordFailure(site);
    }
    const status = getCircuitStatus(site);
    expect(status.state).toBe("open");
    expect(status.failures).toBe(failures);
    expect(isAllowed(site)).toBe(false);
    expect(retryAfterSeconds(site)).toBeGreaterThan(0);
  });

  test("resets on recordSuccess after being tripped", async () => {
    const site = `test-reset-${Date.now()}.example.com`;
    for (let i = 0; i < 5; i++) {
      await recordFailure(site);
    }
    expect(isAllowed(site)).toBe(false);

    await recordSuccess(site);
    const status = getCircuitStatus(site);
    expect(status.state).toBe("closed");
    expect(status.failures).toBe(0);
    expect(isAllowed(site)).toBe(true);
  });
});
