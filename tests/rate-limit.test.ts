import { beforeAll, describe, expect, it } from "bun:test";
import { migrate } from "../src/db";
import { checkRateLimit, cleanupRateLimits } from "../src/middleware/rate-limit";

describe("rate-limit", () => {
  beforeAll(() => {
    migrate();
  });

  it("allows requests under the limit and tracks remaining", async () => {
    const ip = `192.168.1.${Math.floor(Math.random() * 200 + 10)}`;
    const path = "/task";

    const first = await checkRateLimit(ip, path);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(19);

    const second = await checkRateLimit(ip, path);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(18);
  });

  it("blocks requests when limit exceeded", async () => {
    const ip = `10.0.0.${Math.floor(Math.random() * 200 + 10)}`;
    const path = "/login"; // limit 5

    for (let i = 0; i < 5; i++) {
      const res = await checkRateLimit(ip, path);
      expect(res.allowed).toBe(true);
    }

    const blocked = await checkRateLimit(ip, path);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  it("cleans up old windows without error", () => {
    expect(() => cleanupRateLimits()).not.toThrow();
  });
});
