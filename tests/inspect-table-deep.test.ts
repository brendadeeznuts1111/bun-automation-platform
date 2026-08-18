/**
 * Deep audit: Bun.inspect.table() edge cases — Bugs 19-22.
 *
 * XREF: Bug cross-reference chain — see docs/render-diagrams.ts#cross-reference-chain
 * This file covers Bug 17 (doc:1857), 19, 20, 21, 22 (doc:2229)
 *
 * Verifies:
 * - Bug 19: Symbol keys appear as column headers but cells are empty
 * - Bug 20: String/Number/undefined/null/boolean input produces empty string
 * - Bug 21: Mixed types create confusing column layout
 * - Bug 22: Error objects render full stack trace in cells
 * - Various type handling (Date, RegExp, Promise, TypedArray, etc.)
 *
 * Ref: https://bun.com/docs/runtime/utils#bun-inspect-table-tabulardata-properties-options
 */

import { describe, expect, test } from "bun:test";

// JUSTIFIED: bun-types only declares { colors?: boolean } for Bun.inspect.table
// options, but the `depth` option works at runtime (undocumented — Bug 17).
// Ref: https://bun.com/docs/runtime/utils#bun-inspect-table-tabulardata-properties-options
type TableDepthOptions = { colors?: boolean; depth?: number };
const withDepth = (depth: number): TableDepthOptions => ({ depth });

describe("Bun.inspect.table() deep edge cases", () => {
  describe("type handling in cells", () => {
    test("Date objects show ISO string", () => {
      const out = Bun.inspect.table([{ d: new Date("2024-01-01T00:00:00.000Z") }]);
      expect(out).toContain("2024-01-01");
    });

    test("RegExp shows pattern and flags", () => {
      const out = Bun.inspect.table([{ r: /pattern/g }]);
      expect(out).toContain("/pattern/g");
    });

    test("Promise shows resolved state", () => {
      const out = Bun.inspect.table([{ p: Promise.resolve(1) }]);
      expect(out).toContain("Promise");
    });

    test("TypedArray shows type and contents", () => {
      const out = Bun.inspect.table([{ u8: new Uint8Array([1, 2, 3]) }]);
      expect(out).toContain("Uint8Array");
      expect(out).toContain("1");
    });

    test("BigInt shows with n suffix", () => {
      const out = Bun.inspect.table([{ big: 9007199254740993n }]);
      expect(out).toContain("9007199254740993n");
    });

    test("NaN, Infinity, -Infinity display correctly", () => {
      const out = Bun.inspect.table([{ nan: NaN, inf: Infinity, negInf: -Infinity }]);
      expect(out).toContain("NaN");
      expect(out).toContain("Infinity");
      expect(out).toContain("-Infinity");
    });

    test("-0 displays as -0", () => {
      const out = Bun.inspect.table([{ z: -0 }]);
      expect(out).toContain("-0");
    });

    test("null and undefined display distinctly", () => {
      const out = Bun.inspect.table([{ a: null, b: undefined, c: 0, d: "" }]);
      expect(out).toContain("null");
      expect(out).toContain("undefined");
    });

    test("functions show as [Function: name]", () => {
      const named = function foo() {};
      const out = Bun.inspect.table([{ fn: () => 1, named }]);
      expect(out).toContain("[Function:");
    });
  });

  describe("structural edge cases", () => {
    test("circular reference shows [Circular]", () => {
      const circ: Record<string, unknown> = { a: 1 };
      circ.self = circ;
      const out = Bun.inspect.table([circ]);
      expect(out).toContain("[Circular]");
    });

    test("sparse array shows undefined for gaps", () => {
      const sparse = new Array(5);
      sparse[0] = "a";
      sparse[2] = "c";
      sparse[4] = "e";
      const out = Bun.inspect.table(sparse);
      expect(out).toContain("a");
      expect(out).toContain("undefined");
      expect(out).toContain("c");
    });

    test("getters are called and values displayed", () => {
      const arr: string[] = [];
      Object.defineProperty(arr, 0, { get: () => "getter value", enumerable: true });
      arr[1] = "normal";
      const out = Bun.inspect.table(arr);
      expect(out).toContain("getter value");
    });

    test("Proxy objects are transparent", () => {
      const target: Record<string, number> = { a: 1, b: 2 };
      const proxy = new Proxy(target, {
        get(t: Record<string, number>, k: string) {
          return t[k];
        },
      });
      const out = Bun.inspect.table([proxy]);
      expect(out).toContain("1");
      expect(out).toContain("2");
    });

    test("frozen objects work", () => {
      const frozen = Object.freeze({ a: 1, b: 2 });
      const out = Bun.inspect.table([frozen]);
      expect(out).toContain("1");
    });

    test("null-prototype objects work", () => {
      const noProto = Object.create(null);
      noProto.x = 1;
      noProto.y = 2;
      const out = Bun.inspect.table([noProto]);
      expect(out).toContain("1");
    });

    test("long strings expand column width (no truncation)", () => {
      const long = "A".repeat(200);
      const out = Bun.inspect.table([{ x: long, y: "short" }]);
      expect(out).toContain(long);
    });

    test("nested arrays as cells use indices as column headers", () => {
      const out = Bun.inspect.table([
        [1, 2, 3],
        [4, 5, 6],
      ]);
      // Bun.inspect.table uses Unicode box-drawing, not HTML <table>
      expect(out).toContain("┌");
      expect(out).toContain("│ 0 │");
      expect(out).toContain("│ 1 │");
      expect(out).toContain("│ 2 │");
    });

    test("Map input shows Key/Values columns", () => {
      const out = Bun.inspect.table(new Map([["a", 1]]));
      expect(out).toContain("Key");
      expect(out).toContain("Values");
    });

    test("Set input shows Values column", () => {
      const out = Bun.inspect.table(new Set([1, 2, 3]));
      expect(out).toContain("Values");
    });
  });

  describe("properties filter", () => {
    test("non-existent keys show empty columns", () => {
      const out = Bun.inspect.table([{ a: 1, b: 2 }], ["x", "y", "z"]);
      expect(out).toContain("x");
      expect(out).toContain("y");
      expect(out).toContain("z");
    });

    test("mix of existing and non-existent keys", () => {
      const out = Bun.inspect.table([{ a: 1, b: 2 }], ["a", "z"]);
      expect(out).toContain("a");
      expect(out).toContain("z");
      expect(out).toContain("1");
    });

    test("empty properties array shows just index column", () => {
      const out = Bun.inspect.table([{ a: 1, b: 2 }], []);
      // Only the index column (0) appears — no property columns
      expect(out).toContain("│ 0 │");
      expect(out).not.toContain("a");
      expect(out).not.toContain("b");
    });
  });

  describe("custom inspect in table cells", () => {
    test("custom inspect string output used as cell value", () => {
      class C {
        [Bun.inspect.custom]() {
          return "Custom{...}";
        }
      }
      const out = Bun.inspect.table([{ c: new C() }]);
      expect(out).toContain("Custom{...}");
    });

    test("custom inspect object output rendered inline", () => {
      class C {
        [Bun.inspect.custom]() {
          return { x: 1, y: 2 };
        }
      }
      const out = Bun.inspect.table([{ c: new C() }]);
      expect(out).toContain("x: 1");
      expect(out).toContain("y: 2");
    });
  });

  describe("Bug 19: Symbol keys appear as column headers (empty cells)", () => {
    test("symbol-keyed properties create column headers from description", () => {
      const s = Symbol("hidden");
      const out = Bun.inspect.table([{ [s]: "val", normal: "yes" }]);
      // Bug: Symbol description "hidden" appears as a column header
      expect(out).toContain("hidden");
      // Bug: The cell for the symbol key is EMPTY (value "val" not shown)
      // The "normal" column works fine
      expect(out).toContain("yes");
    });
  });

  describe("Bug 20: non-array input produces empty string (silent failure)", () => {
    // JUSTIFIED: Bun.inspect.table type signature only accepts object[],
    // but the runtime accepts any input. These tests verify the runtime
    // behavior of passing invalid types — the `as never` cast is needed
    // because the types correctly reject these inputs.
    test("string input produces empty string (no error)", () => {
      expect(Bun.inspect.table("hello" as never)).toBe("");
    });

    test("number input produces empty string (no error)", () => {
      expect(Bun.inspect.table(42 as never)).toBe("");
    });

    test("undefined input produces empty string (no error)", () => {
      expect(Bun.inspect.table(undefined as never)).toBe("");
    });

    test("null input produces empty string (no error)", () => {
      expect(Bun.inspect.table(null as never)).toBe("");
    });

    test("boolean input produces empty string (no error)", () => {
      expect(Bun.inspect.table(true as never)).toBe("");
    });
  });

  describe("Bug 21: mixed types create confusing column layout", () => {
    test("objects + primitives + arrays merge all keys into columns", () => {
      const mixed = [{ a: 1 }, "string", [10, 20], { b: 2 }, 42];
      const out = Bun.inspect.table(mixed);
      // All object property names AND array indices AND "Values" appear as columns
      expect(out).toContain("a");
      expect(out).toContain("b");
      expect(out).toContain("Values");
    });
  });

  describe("Bug 22: Error objects render full stack trace in cells", () => {
    test("Error in cell shows stack trace (not just message)", () => {
      const out = Bun.inspect.table([{ e: new Error("test error") }]);
      // Bug: Full stack trace with source code context is rendered
      // instead of just "Error: test error"
      expect(out).toContain("test error");
      // The output is much longer than just the error message
      expect(out.length).toBeGreaterThan(100);
    });
  });

  describe("depth option (Bug 17 — inverted)", () => {
    test("depth: 0 shows more nesting than depth: 5", () => {
      const deep = { a: { b: { c: { d: { e: { f: "leaf" } } } } } };
      const out0 = Bun.inspect.table([{ obj: deep }], withDepth(0));
      const out5 = Bun.inspect.table([{ obj: deep }], withDepth(5));
      // depth: 0 shows MORE (inverted), depth: 5 shows LESS
      expect(out0.length).toBeGreaterThan(out5.length);
    });
  });
});
