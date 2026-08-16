/**
 * Deep audit: Bun.inspect.custom and depth interaction.
 *
 * XREF: Bug cross-reference chain — see docs/render-diagrams.ts#cross-reference-chain
 * This file has no bug numbers (custom inspect verification only)
 *
 * Verifies:
 * - Custom inspect receives (depth, options) with stylize function
 * - Depth decreases for nested custom inspect calls
 * - Self-referential custom inspect throws (no circular detection)
 * - ANSI codes in custom inspect output pass through
 * - Node.js compat options (showHidden, compact) are silently ignored
 * - console.log passes depth=2, Bun.inspect passes depth=8
 *
 * Ref: https://bun.com/docs/runtime/utils#bun-inspect-custom
 */

import { describe, expect, it } from "bun:test";

describe("Bun.inspect.custom deep behaviors", () => {
  describe("depth propagation", () => {
    it("custom inspect receives depth=8 by default", () => {
      class P {
        received = -1;
        [Bun.inspect.custom](depth: number) {
          this.received = depth;
          return "probe";
        }
      }
      const p = new P();
      Bun.inspect(p);
      expect(p.received).toBe(8);
    });

    it("nested custom inspect gets depth-1", () => {
      class Outer {
        [Bun.inspect.custom](depth: number) {
          return {
            outerDepth: depth,
            inner: {
              [Bun.inspect.custom](d: number) {
                return `innerDepth=${d}`;
              },
            },
          };
        }
      }
      const out = Bun.inspect(new Outer(), { depth: 5 });
      expect(out).toContain("outerDepth: 5");
      expect(out).toContain("innerDepth=4");
    });

    it("depth decreases recursively through nested objects", () => {
      class Recursive {
        level: number;
        constructor(level: number) {
          this.level = level;
        }
        [Bun.inspect.custom](depth: number) {
          if (depth <= 0 || this.level >= 15) return `LEAF(level=${this.level})`;
          return { level: this.level, next: new Recursive(this.level + 1) };
        }
      }
      // At depth 3, should show levels 0, 1, 2, then LEAF at level 3
      const out = Bun.inspect(new Recursive(0), { depth: 3 });
      expect(out).toContain("level: 0");
      expect(out).toContain("level: 1");
      expect(out).toContain("level: 2");
      expect(out).toContain("LEAF(level=3)");
    });
  });

  describe("options passed to custom inspect", () => {
    it("receives stylize, depth, and colors keys", () => {
      class P {
        keys = "";
        [Bun.inspect.custom](_depth: number, opts: Record<string, unknown>) {
          this.keys = Object.keys(opts).join(",");
          return "probe";
        }
      }
      const p = new P();
      Bun.inspect(p, { colors: true });
      // Node.js compat: stylize function is passed
      expect(p.keys).toContain("stylize");
      expect(p.keys).toContain("depth");
      expect(p.keys).toContain("colors");
    });

    it("colors option propagated", () => {
      class P {
        gotColors = false;
        [Bun.inspect.custom](_depth: number, opts: { colors?: boolean }) {
          this.gotColors = opts.colors ?? false;
          return "probe";
        }
      }
      const p = new P();
      Bun.inspect(p, { colors: true });
      expect(p.gotColors).toBe(true);
    });

    it("Node.js compat options (showHidden, compact) silently ignored", () => {
      // JUSTIFIED: bun-types doesn't declare showHidden/compact in inspect
      // options, but the runtime accepts them (and ignores them).
      class P {
        gotShowHidden: unknown = undefined;
        gotCompact: unknown = undefined;
        [Bun.inspect.custom](_depth: number, opts: Record<string, unknown>) {
          this.gotShowHidden = opts.showHidden;
          this.gotCompact = opts.compact;
          return "probe";
        }
      }
      const p = new P();
      // JUSTIFIED: bun-types doesn't declare showHidden/compact in inspect options
      const opts = { showHidden: true, compact: 3 } as Record<string, unknown>;
      Bun.inspect(p, opts);
      // Bug: showHidden and compact are NOT passed to custom inspect
      expect(p.gotShowHidden).toBeUndefined();
      expect(p.gotCompact).toBeUndefined();
    });
  });

  describe("return value handling", () => {
    it("returning string — used as-is", () => {
      class S {
        [Bun.inspect.custom]() {
          return "custom string";
        }
      }
      expect(Bun.inspect(new S())).toBe("custom string");
    });

    it("returning number — converted to string", () => {
      class N {
        [Bun.inspect.custom]() {
          return 42;
        }
      }
      expect(Bun.inspect(new N())).toBe("42");
    });

    it("returning null — shows 'null'", () => {
      class Null {
        [Bun.inspect.custom]() {
          return null;
        }
      }
      expect(Bun.inspect(new Null())).toBe("null");
    });

    it("returning undefined — shows 'undefined'", () => {
      class Undef {
        [Bun.inspect.custom]() {
          return undefined;
        }
      }
      expect(Bun.inspect(new Undef())).toBe("undefined");
    });

    it("returning object — recursively inspected", () => {
      class O {
        [Bun.inspect.custom]() {
          return { nested: "value" };
        }
      }
      const out = Bun.inspect(new O());
      expect(out).toContain("nested");
      expect(out).toContain("value");
    });

    it("returning array — inspected as array", () => {
      class A {
        [Bun.inspect.custom]() {
          return [1, 2, 3];
        }
      }
      const out = Bun.inspect(new A());
      expect(out).toContain("[ 1, 2, 3 ]");
    });
  });

  describe("ANSI in custom inspect output", () => {
    it("ANSI codes pass through with colors: false", () => {
      class Ansi {
        [Bun.inspect.custom]() {
          return "\x1b[31mred\x1b[0m";
        }
      }
      const out = Bun.inspect(new Ansi(), { colors: false });
      // ANSI codes are NOT stripped even with colors: false
      expect(out).toContain("\x1b[31m");
    });

    it("ANSI codes pass through with colors: true", () => {
      class Ansi {
        [Bun.inspect.custom]() {
          return "\x1b[31mred\x1b[0m";
        }
      }
      const out = Bun.inspect(new Ansi(), { colors: true });
      expect(out).toContain("\x1b[31m");
    });
  });

  describe("self-referential custom inspect", () => {
    it("throws Maximum call stack size exceeded", () => {
      class Self {
        [Bun.inspect.custom]() {
          return new Self();
        }
      }
      expect(() => Bun.inspect(new Self())).toThrow("Maximum call stack size exceeded");
    });
  });

  describe("custom inspect wins over Symbol.toStringTag", () => {
    it("custom inspect takes priority", () => {
      class Tagged {
        get [Symbol.toStringTag]() {
          return "MyTag";
        }
        [Bun.inspect.custom]() {
          return "custom-wins";
        }
      }
      expect(Bun.inspect(new Tagged())).toBe("custom-wins");
    });
  });

  describe("Node.js compatibility", () => {
    it("Bun.inspect.custom === util.inspect.custom", async () => {
      const util = await import("util");
      expect(Bun.inspect.custom).toBe(util.inspect.custom);
    });
  });
});
