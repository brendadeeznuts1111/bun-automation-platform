import { beforeAll, describe, expect, test } from "bun:test";
import { migrate } from "../src/db";
import { checkRateLimit, cleanupRateLimits } from "../src/middleware/rate-limit";

describe("rate-limit", () => {
  beforeAll(() => {
    migrate();
  });

  test("allows requests under the limit and tracks remaining", async () => {
    const ip = `192.168.1.${Math.floor(Math.random() * 200 + 10)}`;
    const path = "/task";
    const method = "POST";

    const first = await checkRateLimit(ip, path, method);
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(19);

    const second = await checkRateLimit(ip, path, method);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(18);
  });

  test("blocks requests when limit exceeded", async () => {
    const ip = `10.0.0.${Math.floor(Math.random() * 200 + 10)}`;
    const path = "/login"; // limit 5
    const method = "POST";

    for (let i = 0; i < 5; i++) {
      const res = await checkRateLimit(ip, path, method);
      expect(res.allowed).toBe(true);
    }

    const blocked = await checkRateLimit(ip, path, method);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  test("E11: separates rate limits by HTTP method", async () => {
    const ip = `172.16.0.${Math.floor(Math.random() * 200 + 10)}`;
    const path = "/task";

    // Exhaust POST limit (20)
    for (let i = 0; i < 20; i++) {
      expect((await checkRateLimit(ip, path, "POST")).allowed).toBe(true);
    }
    // POST should now be blocked
    expect((await checkRateLimit(ip, path, "POST")).allowed).toBe(false);
    // GET should still be allowed (separate bucket)
    expect((await checkRateLimit(ip, path, "GET")).allowed).toBe(true);
  });

  test("cleans up old windows without error", () => {
    expect(() => cleanupRateLimits()).not.toThrow();
  });
});
