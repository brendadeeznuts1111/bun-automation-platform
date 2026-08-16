/**
 * Deep audit: Bun.password, Bun.CSRF, Bun.color, Bun.semver, Bun.hash, Bun.Glob.
 *
 * Verifies:
 * - Bun.password: all 4 algorithms (argon2id, argon2d, argon2i, bcrypt)
 * - Bun.CSRF: all 3 algorithms (sha256, sha384, sha512)
 * - Bun.color: 16 output formats, named colors, invalid colors
 * - Bun.semver: satisfies, order, prerelease
 * - Bun.hash: wyhash, crc32, adler32, seed support
 * - Bun.Glob: match, scan, brace expansion
 * - Bun.sleep: Date input, 0, negative
 * - Bun.peek: non-promise values, status
 *
 * Ref: https://bun.com/docs/runtime/utils
 */

import { describe, expect, it } from "bun:test";

describe("Bun.password", () => {
  const pw = "test-password-123";

  it.each(["argon2id", "argon2d", "argon2i", "bcrypt"] as const)(
    "algorithm %s hashes and verifies",
    async (algorithm) => {
      const hash = await Bun.password.hash(pw, { algorithm });
      expect(hash).toBeTruthy();
      expect(await Bun.password.verify(pw, hash)).toBe(true);
      expect(await Bun.password.verify("wrong", hash)).toBe(false);
    },
  );

  it("bcrypt cost affects hash", async () => {
    const h1 = await Bun.password.hash(pw, { algorithm: "bcrypt", cost: 4 });
    const h2 = await Bun.password.hash(pw, { algorithm: "bcrypt", cost: 10 });
    expect(h1).not.toBe(h2);
    expect(h1.startsWith("$2b$")).toBe(true);
  });
});

describe("Bun.CSRF", () => {
  const secret = "test-secret-key-32-bytes-min!!!";

  it.each(["sha256", "sha384", "sha512"] as const)(
    "algorithm %s generates and verifies",
    (algorithm) => {
      const token = Bun.CSRF.generate(secret, { algorithm });
      expect(token).toBeTruthy();
      expect(Bun.CSRF.verify(token, { secret, algorithm })).toBe(true);
    },
  );

  it("rejects wrong secret", () => {
    const token = Bun.CSRF.generate(secret, { algorithm: "sha256" });
    expect(Bun.CSRF.verify(token, { secret: "wrong-secret-key-32-bytes!", algorithm: "sha256" })).toBe(false);
  });

  it("rejects wrong algorithm", () => {
    const token = Bun.CSRF.generate(secret, { algorithm: "sha256" });
    expect(Bun.CSRF.verify(token, { secret, algorithm: "sha512" })).toBe(false);
  });
});

describe("Bun.color", () => {
  it("converts hex to hex", () => {
    expect(Bun.color("#ff5733", "hex")).toBe("#ff5733");
  });

  it("converts hex to uppercase HEX", () => {
    expect(Bun.color("#ff5733", "HEX")).toBe("#FF5733");
  });

  it("converts hex to rgb", () => {
    expect(Bun.color("#ff5733", "rgb")).toBe("rgb(255, 87, 51)");
  });

  it("converts hex to rgba (with alpha)", () => {
    expect(Bun.color("#ff573380", "rgba")).toContain("rgba(255, 87, 51");
  });

  it("converts hex to hsl", () => {
    expect(Bun.color("#ff5733", "hsl")).toContain("hsl(");
  });

  it("converts hex to number", () => {
    expect(Bun.color("#ff5733", "number")).toBe(16734003);
  });

  it("converts hex to lab", () => {
    expect(Bun.color("#ff5733", "lab")).toContain("lab(");
  });

  it("converts to [rgb] array", () => {
    // JUSTIFIED: bun-types doesn't declare array output formats
    const result = Bun.color("#ff5733", "[rgb]" as never);
    expect(Array.isArray(result)).toBe(true);
  });

  it("converts to {rgb} object", () => {
    // JUSTIFIED: bun-types doesn't declare object output formats
    const result = Bun.color("#ff5733", "{rgb}" as never) as unknown as Record<string, number>;
    expect(result.r).toBe(255);
    expect(result.g).toBe(87);
    expect(result.b).toBe(51);
  });

  it("named colors work", () => {
    expect(Bun.color("red", "hex")).toBe("#ff0000");
    expect(Bun.color("blue", "rgb")).toBe("rgb(0, 0, 255)");
  });

  it("invalid color returns null", () => {
    expect(Bun.color("not-a-color")).toBeNull();
    expect(Bun.color("")).toBeNull();
  });

  it("white and black numbers", () => {
    expect(Bun.color("white", "number")).toBe(16777215);
    expect(Bun.color("black", "number")).toBe(0);
  });
});

describe("Bun.semver", () => {
  it("satisfies ^ caret range", () => {
    expect(Bun.semver.satisfies("1.2.3", "^1.0.0")).toBe(true);
    expect(Bun.semver.satisfies("2.0.0", "^1.0.0")).toBe(false);
  });

  it("satisfies ~ tilde range", () => {
    expect(Bun.semver.satisfies("1.2.3", "~1.2.0")).toBe(true);
    expect(Bun.semver.satisfies("1.3.0", "~1.2.0")).toBe(false);
  });

  it("order compares versions", () => {
    expect(Bun.semver.order("1.0.0", "2.0.0")).toBe(-1);
    expect(Bun.semver.order("2.0.0", "1.0.0")).toBe(1);
    expect(Bun.semver.order("1.0.0", "1.0.0")).toBe(0);
  });

  it("order handles prerelease", () => {
    expect(Bun.semver.order("1.0.0-beta", "1.0.0")).toBe(-1);
  });
});

describe("Bun.hash", () => {
  it("wyhash is deterministic", () => {
    expect(Bun.hash("hello")).toBe(Bun.hash("hello"));
  });

  it("wyhash different inputs produce different hashes", () => {
    expect(Bun.hash("hello")).not.toBe(Bun.hash("world"));
  });

  it("wyhash returns BigInt", () => {
    expect(typeof Bun.hash("hello")).toBe("bigint");
  });

  it("crc32 is deterministic", () => {
    expect(Bun.hash.crc32("hello")).toBe(Bun.hash.crc32("hello"));
  });

  it("adler32 is deterministic", () => {
    expect(Bun.hash.adler32("hello")).toBe(Bun.hash.adler32("hello"));
  });

  it("wyhash accepts seed parameter", () => {
    const noSeed = Bun.hash("hello", 0);
    const withSeed = Bun.hash("hello", 1);
    expect(noSeed).not.toBe(withSeed);
  });

  it("accepts Uint8Array input", () => {
    const buf = new TextEncoder().encode("hello");
    expect(Bun.hash(buf)).toBe(Bun.hash("hello"));
  });
});

describe("Bun.Glob", () => {
  it("match returns true for matching pattern", () => {
    const glob = new Bun.Glob("*.ts");
    expect(glob.match("test.ts")).toBe(true);
  });

  it("match returns false for non-matching", () => {
    const glob = new Bun.Glob("*.ts");
    expect(glob.match("test.js")).toBe(false);
  });

  it("** matches nested directories", () => {
    const glob = new Bun.Glob("**/*.ts");
    expect(glob.match("a/b/c.ts")).toBe(true);
    expect(glob.match("a/b/c.js")).toBe(false);
  });

  it("brace expansion works", () => {
    const glob = new Bun.Glob("*.{ts,js}");
    expect(glob.match("a.ts")).toBe(true);
    expect(glob.match("a.js")).toBe(true);
    expect(glob.match("a.py")).toBe(false);
  });

  it("character class works", () => {
    const glob = new Bun.Glob("[abc].ts");
    expect(glob.match("a.ts")).toBe(true);
    expect(glob.match("d.ts")).toBe(false);
  });

  it("scan returns matching files", async () => {
    const glob = new Bun.Glob("*.ts");
    const matches: string[] = [];
    for await (const m of glob.scan({ cwd: "/tmp" })) {
      matches.push(m);
      if (matches.length >= 5) break;
    }
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((m) => m.endsWith(".ts"))).toBe(true);
  });
});

describe("Bun.sleep", () => {
  it("sleep(0) resolves", async () => {
    await Bun.sleep(0);
    expect(true).toBe(true);
  });

  it("sleep with Date resolves", async () => {
    // JUSTIFIED: bun-types declares sleep input as number, but runtime accepts Date
    await Bun.sleep(new Date(Date.now() + 1) as unknown as number);
    expect(true).toBe(true);
  });

  it("sleep negative does not throw", async () => {
    await Bun.sleep(-1);
    expect(true).toBe(true);
  });
});

describe("Bun.sleepSync", () => {
  it("sleepSync(0) works", () => {
    Bun.sleepSync(0);
    expect(true).toBe(true);
  });

  it("Bug 34: sleepSync with Date throws (unlike Bun.sleep)", () => {
    // Bug: Bun.sleep accepts Date, but Bun.sleepSync does NOT
    // sleepSync throws "Expected milliseconds to be a number"
    expect(() => Bun.sleepSync(new Date(Date.now() + 1) as unknown as number)).toThrow();
  });

  it("sleepSync negative throws", () => {
    expect(() => Bun.sleepSync(-1)).toThrow();
  });
});

describe("Bun.peek", () => {
  it("returns value from resolved promise", () => {
    expect(Bun.peek(Promise.resolve("hi"))).toBe("hi");
  });

  it("returns same promise if pending", () => {
    const pending = new Promise(() => {});
    expect(Bun.peek(pending)).toBe(pending);
  });

  it("returns non-promise values as-is", () => {
    // JUSTIFIED: bun-types declares peek as (Promise<T>) => T | Promise<T>
    // but runtime accepts non-promises and returns them directly.
    // JUSTIFIED: cast needed for 42 as non-promise input
    expect(Bun.peek(42 as unknown as Promise<number>)).toBe(42);
    // JUSTIFIED: cast needed for string as non-promise input
    expect(Bun.peek("hello" as unknown as Promise<string>)).toBe("hello");
  });

  it("status returns fulfilled for resolved", () => {
    expect(Bun.peek.status(Promise.resolve(1))).toBe("fulfilled");
  });

  it("status returns pending for unresolved", () => {
    expect(Bun.peek.status(new Promise(() => {}))).toBe("pending");
  });

  it("status returns rejected for rejected", () => {
    const rejected = Promise.reject(new Error("x"));
    // Handle unhandled rejection to prevent test crash
    rejected.catch(() => {});
    expect(Bun.peek.status(rejected)).toBe("rejected");
  });
});

describe("Bun.which", () => {
  it("finds ls in PATH", () => {
    const ls = Bun.which("ls");
    expect(ls).toBeTruthy();
    expect(ls).toContain("ls");
  });

  it("returns null for nonexistent binary", () => {
    expect(Bun.which("nonexistent-binary-xyz-123")).toBeNull();
  });

  it("accepts PATH option", () => {
    // With restricted PATH, ls may not be found
    const result = Bun.which("ls", { PATH: "" });
    expect(result).toBeNull();
  });
});

describe("Bun.randomUUIDv7", () => {
  it("generates UUID v7 format", () => {
    const id = Bun.randomUUIDv7();
    // UUID v7: first 48 bits are timestamp, version nibble is 7
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("generates monotonic IDs (sorted)", () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(Bun.randomUUIDv7());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it("buffer encoding returns 16-byte Buffer", () => {
    const buf = Bun.randomUUIDv7("buffer");
    expect(buf.length).toBe(16);
  });

  it("base64 encoding returns shorter string", () => {
    const hex = Bun.randomUUIDv7("hex");
    const base64 = Bun.randomUUIDv7("base64");
    expect(base64.length).toBeLessThan(hex.length);
  });

  it("accepts explicit timestamp", () => {
    const id1 = Bun.randomUUIDv7("hex", 1700000000000);
    const id2 = Bun.randomUUIDv7("hex", 1700000000000);
    // Same timestamp but different counter — still sortable
    expect(id1).not.toBe(id2);
  });
});
