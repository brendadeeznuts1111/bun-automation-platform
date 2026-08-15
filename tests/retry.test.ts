import { describe, expect, it } from "bun:test";
import { withRetry } from "../src/utils/retry";

describe("withRetry", () => {
  it("resolves immediately when function succeeds", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return "success";
    });
    expect(result).toBe("success");
    expect(calls).toBe(1);
  });

  it("retries on failure up to maxAttempts", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("transient error");
        }
        return "recovered";
      },
      { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 },
    );

    expect(result).toBe("recovered");
    expect(attempts).toBe(3);
  });

  it("throws last error when exceeding maxAttempts", async () => {
    let attempts = 0;
    expect(
      withRetry(
        async () => {
          attempts++;
          throw new Error(`failure ${attempts}`);
        },
        { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 20 },
      ),
    ).rejects.toThrow("failure 2");
  });

  it("respects retryable predicate", async () => {
    let attempts = 0;
    expect(
      withRetry(
        async () => {
          attempts++;
          throw new TypeError("fatal type error");
        },
        {
          maxAttempts: 3,
          baseDelayMs: 10,
          retryable: (err) => !(err instanceof TypeError),
        },
      ),
    ).rejects.toThrow("fatal type error");

    expect(attempts).toBe(1);
  });
});
