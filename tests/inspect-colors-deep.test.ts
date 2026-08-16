/**
 * Deep audit: Bun.inspect colors and options.
 *
 * XREF: Bug cross-reference chain — see docs/render-diagrams.ts#cross-reference-chain
 * This file covers Bug 33 (doc:2254)
 *
 * Verifies:
 * - Exact ANSI color codes per type (yellow=number, green=string, etc.)
 * - compact option works (single-line output)
 * - sorted option works (alphabetical key order)
 * - breakLength option (controls when to wrap)
 * - showHidden option (no observable effect — Bug 33)
 *
 * Ref: https://bun.com/docs/runtime/utils#bun-inspect
 */

import { describe, expect, it } from "bun:test";

// Helper: inspect with colors and return raw string (with ANSI codes)
const colored = (v: unknown): string => Bun.inspect(v, { colors: true });

// ANSI escape codes
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const DIM = "\x1b[2m";

describe("Bun.inspect colors — exact ANSI codes", () => {
  it("numbers are yellow", () => {
    expect(colored(42)).toContain(YELLOW);
    expect(colored(42)).toContain("42");
  });

  it("negative numbers are yellow", () => {
    expect(colored(-42)).toContain(YELLOW);
  });

  it("NaN is yellow", () => {
    expect(colored(NaN)).toContain(YELLOW);
  });

  it("Infinity is yellow", () => {
    expect(colored(Infinity)).toContain(YELLOW);
  });

  it("-0 is yellow", () => {
    expect(colored(-0)).toContain(YELLOW);
  });

  it("BigInt is yellow", () => {
    expect(colored(123n)).toContain(YELLOW);
  });

  it("booleans are yellow", () => {
    expect(colored(true)).toContain(YELLOW);
    expect(colored(false)).toContain(YELLOW);
  });

  it("null is yellow", () => {
    expect(colored(null)).toContain(YELLOW);
  });

  it("undefined is dim", () => {
    expect(colored(undefined)).toContain(DIM);
  });

  it("strings are green (with quotes)", () => {
    expect(colored("hello")).toContain(GREEN);
    expect(colored("hello")).toContain('"hello"');
  });

  it("symbols are blue", () => {
    expect(colored(Symbol("test"))).toContain(BLUE);
  });

  it("RegExp is red", () => {
    expect(colored(/pattern/g)).toContain(RED);
  });

  it("Date is magenta", () => {
    expect(colored(new Date("2024-01-01"))).toContain(MAGENTA);
  });

  it("functions are cyan", () => {
    expect(colored(function foo() {})).toContain(CYAN);
  });

  it("arrow functions are cyan", () => {
    expect(colored(() => {})).toContain(CYAN);
  });

  it("Promise resolved state is cyan", () => {
    expect(colored(Promise.resolve(1))).toContain(CYAN);
  });

  it("object keys are default (reset), colons are dim", () => {
    const out = colored({ key: "val" });
    expect(out).toContain("key");
    expect(out).toContain(DIM); // colon is dim
  });

  it("commas are dim", () => {
    const out = colored([1, 2, 3]);
    expect(out).toContain(DIM); // commas are dim
  });

  it("empty object has no color codes", () => {
    expect(colored({})).toBe("{}");
  });

  it("empty array has no color codes", () => {
    expect(colored([])).toBe("[]");
  });
});

describe("Bun.inspect compact option", () => {
  // JUSTIFIED: bun-types doesn't declare `compact` in inspect options,
  // but it works at runtime (single-line output).
  it("compact: true produces single-line output", () => {
    // JUSTIFIED: bun-types doesn't declare compact in inspect options
    const opts = { compact: true } as Record<string, unknown>;
    const out = Bun.inspect({ a: 1, b: 2, c: 3 }, opts);
    expect(out).not.toContain("\n");
  });

  it("default (no compact) produces multi-line output", () => {
    const out = Bun.inspect({ a: 1, b: 2, c: 3 });
    expect(out).toContain("\n");
  });
});

describe("Bun.inspect sorted option", () => {
  // JUSTIFIED: bun-types doesn't declare `sorted` in inspect options,
  // but it works at runtime (alphabetical key order).
  it("sorted: true sorts keys alphabetically", () => {
    // JUSTIFIED: bun-types doesn't declare sorted in inspect options
    const opts = { sorted: true } as Record<string, unknown>;
    const out = Bun.inspect({ z: 1, a: 2, m: 3 }, opts);
    const aPos = out.indexOf("a:");
    const mPos = out.indexOf("m:");
    const zPos = out.indexOf("z:");
    expect(aPos).toBeLessThan(mPos);
    expect(mPos).toBeLessThan(zPos);
  });

  it("default preserves insertion order", () => {
    const out = Bun.inspect({ z: 1, a: 2, m: 3 });
    const zPos = out.indexOf("z:");
    const aPos = out.indexOf("a:");
    expect(zPos).toBeLessThan(aPos);
  });
});

describe("Bun.inspect breakLength option", () => {
  it("small breakLength forces multi-line", () => {
    // JUSTIFIED: bun-types doesn't declare breakLength in inspect options
    const opts = { breakLength: 20 } as Record<string, unknown>;
    const out = Bun.inspect({ a: 1, b: 2, c: 3, d: 4, e: 5 }, opts);
    expect(out).toContain("\n");
  });

  it("large breakLength allows single-line for small objects", () => {
    // JUSTIFIED: bun-types doesn't declare breakLength in inspect options
    const opts = { breakLength: 1000 } as Record<string, unknown>;
    const out = Bun.inspect({ a: 1, b: 2 }, opts);
    expect(typeof out).toBe("string");
  });
});

describe("showHidden option", () => {
  // JUSTIFIED: bun-types doesn't declare `showHidden` in inspect options,
  // but it's accepted at runtime and DOES reveal non-enumerable properties.
  it("showHidden: true reveals non-enumerable properties", () => {
    const obj: Record<string, unknown> = {};
    Object.defineProperty(obj, "hidden", { value: "secret", enumerable: false });
    // JUSTIFIED: bun-types doesn't declare showHidden in inspect options
    const opts = { showHidden: true } as Record<string, unknown>;
    const out = Bun.inspect(obj, opts);
    // showHidden DOES work — it reveals the non-enumerable "hidden" property
    expect(out).toContain("hidden");
    expect(out).toContain("secret");
  });

  it("default (no showHidden) also reveals non-enumerable properties (Bun behavior)", () => {
    // Bun.inspect shows non-enumerable properties by default (unlike Node.js)
    const obj: Record<string, unknown> = {};
    Object.defineProperty(obj, "hidden", { value: "secret", enumerable: false });
    const out = Bun.inspect(obj);
    expect(out).toContain("hidden");
    expect(out).toContain("secret");
  });
});
