import { beforeAll, describe, expect, it } from "bun:test";
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

  it("starts in closed state", async () => {
    const site = "test-site-init.example.com";
    await recordSuccess(site);
    const status = getCircuitStatus(site);
    expect(status.state).toBe("closed");
    expect(status.failures).toBe(0);
    expect(isAllowed(site)).toBe(true);
  });

  it("trips after threshold consecutive failures", async () => {
    const site = "test-fail.example.com";
    for (let i = 0; i < 5; i++) {
      await recordFailure(site);
    }
    const status = getCircuitStatus(site);
    expect(status.state).toBe("open");
    expect(isAllowed(site)).toBe(false);
    expect(retryAfterSeconds(site)).toBeGreaterThan(0);
  });

  it("resets on recordSuccess", async () => {
    const site = "test-reset.example.com";
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
