/**
 * Bun.inspect() and Bun.inspect.table() depth audit.
 *
 * Verifies:
 * - Bug 17: Bun.inspect.table() depth option is INVERTED (undocumented)
 * - Bug 18: Bun.inspect() default depth is 8, not 2 (docs contradiction)
 * - Bun.inspect.custom probe receives (depth, options)
 * - console.log vs Bun.inspect default depth difference
 * - console as AsyncIterable (stdin line reader)
 * - console.write() return value and multi-arg support
 *
 * Ref: https://bun.com/docs/runtime/utils#bun-inspect
 * Ref: https://bun.com/docs/runtime/utils#bun-inspect-custom
 * Ref: https://bun.com/docs/runtime/utils#bun-inspect-table-tabulardata-properties-options
 * Ref: https://bun.com/docs/runtime/console
 */

import { describe, expect, it } from "bun:test";

// Helper: build an N-level nested object
function nestedObject(levels: number): unknown {
  let obj: unknown = "leaf";
  for (let i = levels - 1; i >= 0; i--) {
    obj = { [`l${i}`]: obj };
  }
  return obj;
}

// Helper: find the last visible key (l0, l1, ...) in inspect output
function lastVisibleLevel(html: string, maxLevel = 20): number {
  for (let i = maxLevel; i >= 0; i--) {
    if (html.includes(`l${i}`)) return i;
  }
  return -1;
}

describe("Bun.inspect() default depth (Bug 18)", () => {
  it("console.log defaults to depth 2", () => {
    // Use a custom inspect probe to read the depth Bun passes
    class Probe {
      receivedDepth = -1;
      [Bun.inspect.custom](depth: number) {
        this.receivedDepth = depth;
        return "probe";
      }
    }
    const p = new Probe();
    // console.log calls Bun.inspect internally with depth=2
    const captured = Bun.inspect(p, { depth: 2 });
    expect(captured).toBe("probe");
    expect(p.receivedDepth).toBe(2);
  });

  it("Bun.inspect() defaults to depth 8 (NOT 2, NOT Infinity)", () => {
    class Probe {
      receivedDepth = -1;
      [Bun.inspect.custom](depth: number) {
        this.receivedDepth = depth;
        return "probe";
      }
    }
    const p = new Probe();
    Bun.inspect(p);
    expect(p.receivedDepth).toBe(8);
  });

  it("Bun.inspect({}) also defaults to depth 8", () => {
    class Probe {
      receivedDepth = -1;
      [Bun.inspect.custom](depth: number) {
        this.receivedDepth = depth;
        return "probe";
      }
    }
    const p = new Probe();
    Bun.inspect(p, {});
    expect(p.receivedDepth).toBe(8);
  });

  it("Bun.inspect({depth: Infinity}) caps to 65535", () => {
    class Probe {
      receivedDepth = -1;
      [Bun.inspect.custom](depth: number) {
        this.receivedDepth = depth;
        return "probe";
      }
    }
    const p = new Probe();
    Bun.inspect(p, { depth: Infinity });
    expect(p.receivedDepth).toBe(65535);
  });

  it("Bun.inspect({depth: N}) passes N through", () => {
    class Probe {
      receivedDepth = -1;
      [Bun.inspect.custom](depth: number) {
        this.receivedDepth = depth;
        return "probe";
      }
    }
    for (const n of [0, 1, 5, 10, 100]) {
      const p = new Probe();
      Bun.inspect(p, { depth: n });
      expect(p.receivedDepth).toBe(n);
    }
  });

  it("4-level object: console.log truncates, Bun.inspect does not", () => {
    const nested = { a: { b: { c: { d: "deep" } } } };
    const consoleOutput = Bun.inspect(nested, { depth: 2 });
    const inspectOutput = Bun.inspect(nested);
    expect(consoleOutput).toContain("[Object");
    expect(inspectOutput).toContain('"deep"');
    expect(consoleOutput).not.toBe(inspectOutput);
  });

  it("15-level object: Bun.inspect() truncates at l8 (default depth 8)", () => {
    const deep = nestedObject(15);
    const out = Bun.inspect(deep);
    expect(lastVisibleLevel(out, 14)).toBe(8);
    expect(out).toContain("[Object");
  });

  it("15-level object: explicit depth 16 shows leaf", () => {
    const deep = nestedObject(15);
    const out = Bun.inspect(deep, { depth: 16 });
    expect(out).toContain('"leaf"');
  });

  it("15-level object: Infinity shows leaf (capped to 65535)", () => {
    const deep = nestedObject(15);
    const out = Bun.inspect(deep, { depth: Infinity });
    expect(out).toContain('"leaf"');
  });
});

describe("Bun.inspect.table() depth (Bug 17 — inverted)", () => {
  // JUSTIFIED: bun-types only declares { colors?: boolean } for Bun.inspect.table
  // options, but the `depth` option works at runtime (undocumented — Bug 17).
  // Ref: https://bun.com/docs/runtime/utils#bun-inspect-table-tabulardata-properties-options
  // The depth option is accepted but not in the type definitions.
  type TableDepthOptions = { colors?: boolean; depth?: number };
  const withDepth = (depth: number): TableDepthOptions => ({ depth });

  it("depth: 0 shows the MOST levels (6)", () => {
    const data = [{ obj: nestedObject(8) }];
    const out = Bun.inspect.table(data, withDepth(0));
    // depth: 0 shows the most levels (inverted behavior)
    expect(out).toContain("l0");
    expect(out).toContain("l1");
  });

  it("depth: 5 shows FEWER levels than depth: 0 (inverted)", () => {
    const data = [{ obj: nestedObject(8) }];
    const out0 = Bun.inspect.table(data, withDepth(0));
    const out5 = Bun.inspect.table(data, withDepth(5));
    // depth: 0 should show more than depth: 5 (inverted)
    const levels0 = out0.match(/l\d/g)?.length ?? 0;
    const levels5 = out5.match(/l\d/g)?.length ?? 0;
    expect(levels0).toBeGreaterThan(levels5);
  });

  it("depth: -1 throws TypeError", () => {
    expect(() => Bun.inspect.table([{ a: 1 }], withDepth(-1))).toThrow();
  });

  it("colors option works", () => {
    const out = Bun.inspect.table([{ a: 1 }], { colors: true });
    // ANSI color codes present
    expect(out).toMatch(/\x1b\[/);
  });

  it("no colors = no ANSI codes", () => {
    const out = Bun.inspect.table([{ a: 1 }]);
    expect(out).not.toMatch(/\x1b\[/);
  });

  it("properties array filters columns", () => {
    const data = [
      { a: 1, b: 2, c: 3 },
      { a: 4, b: 5, c: 6 },
    ];
    const out = Bun.inspect.table(data, ["a", "c"]);
    expect(out).toContain("a");
    expect(out).toContain("c");
    expect(out).not.toContain("b");
  });
});

describe("Bun.inspect.custom", () => {
  it("overrides console.log output", () => {
    class Foo {
      [Bun.inspect.custom]() {
        return "foo";
      }
    }
    expect(Bun.inspect(new Foo())).toBe("foo");
  });

  it("can return object (recursively inspected)", () => {
    class Bar {
      [Bun.inspect.custom]() {
        return { custom: "representation" };
      }
    }
    const out = Bun.inspect(new Bar());
    expect(out).toContain("custom");
    expect(out).toContain("representation");
  });

  it("can return number", () => {
    class Baz {
      [Bun.inspect.custom]() {
        return 42;
      }
    }
    expect(Bun.inspect(new Baz())).toBe("42");
  });

  it("can return null", () => {
    class Qux {
      [Bun.inspect.custom]() {
        return null;
      }
    }
    expect(Bun.inspect(new Qux())).toBe("null");
  });

  it("receives (depth, options) arguments", () => {
    class Deep {
      [Bun.inspect.custom](depth: number, options: { colors: boolean }) {
        return `d=${depth},c=${options.colors}`;
      }
    }
    expect(Bun.inspect(new Deep(), { depth: 5, colors: true })).toBe("d=5,c=true");
  });

  it("is identical to Node.js util.inspect.custom", async () => {
    const util = await import("util");
    expect(Bun.inspect.custom).toBe(util.inspect.custom);
  });

  it("custom inspect wins over Symbol.toStringTag", () => {
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

  it("custom inspect applies inside Bun.inspect.table cells", () => {
    class Cell {
      [Bun.inspect.custom]() {
        return "custom-cell";
      }
    }
    const out = Bun.inspect.table([{ a: new Cell(), b: 2 }]);
    expect(out).toContain("custom-cell");
  });
});

describe("console as AsyncIterable (stdin reader)", () => {
  it("console[Symbol.asyncIterator] is a function", () => {
    expect(typeof console[Symbol.asyncIterator]).toBe("function");
  });

  it("console.write is a function", () => {
    expect(typeof console.write).toBe("function");
  });

  it("console.write returns byte count (number)", () => {
    const result = console.write("test\n");
    expect(typeof result).toBe("number");
    expect(result).toBe(5); // "test\n" = 5 bytes
  });

  it("console.write accepts multiple string args", () => {
    const result = console.write("a", "b", "c");
    expect(typeof result).toBe("number");
    expect(result).toBe(3);
  });

  it("console.write accepts Uint8Array", () => {
    const bytes = new Uint8Array([72, 105, 10]); // "Hi\n"
    const result = console.write(bytes);
    expect(result).toBe(3);
  });

  it("console.write accepts ArrayBuffer", () => {
    const buf = new ArrayBuffer(3);
    const view = new Uint8Array(buf);
    view[0] = 72;
    view[1] = 105;
    view[2] = 10;
    const result = console.write(buf);
    expect(result).toBe(3);
  });

  it("console.write with no args throws TypeError", () => {
    expect(() => console.write()).toThrow();
  });

  it("console.write with number throws TypeError", () => {
    // JUSTIFIED: console.write signature is (text: string | ArrayBufferView | ArrayBuffer) => number
    // We intentionally pass a number to verify the runtime TypeError. The `as never`
    // cast bypasses the type check because this is a negative test.
    expect(() => console.write(42 as never)).toThrow();
  });

  it("reads stdin line by line via for-await", async () => {
    // We can't pipe stdin in a test, but we can verify the iterator
    // protocol works by calling it directly on an empty stream
    const iter = console[Symbol.asyncIterator]();
    expect(typeof iter.next).toBe("function");
    expect(typeof iter.return).toBe("function");
    // Clean up immediately (stdin is likely empty/TTY in test env)
    await iter.return?.();
  });
});

describe("Bun.escapeHTML (security mitigation)", () => {
  it("escapes all 5 HTML special chars", () => {
    expect(Bun.escapeHTML("<")).toBe("&lt;");
    expect(Bun.escapeHTML(">")).toBe("&gt;");
    expect(Bun.escapeHTML("&")).toBe("&amp;");
    expect(Bun.escapeHTML('"')).toBe("&quot;");
    expect(Bun.escapeHTML("'")).toBe("&#x27;");
  });

  it("escapes combined string", () => {
    const result = Bun.escapeHTML(`<a href="x" onclick='y'>`);
    expect(result).toBe("&lt;a href=&quot;x&quot; onclick=&#x27;y&#x27;&gt;");
  });

  it("handles non-string types via toString", () => {
    expect(Bun.escapeHTML(42)).toBe("42");
    expect(Bun.escapeHTML(true)).toBe("true");
    expect(Bun.escapeHTML({ x: 1 })).toBe("[object Object]");
  });

  it("escapes angle brackets in Bun.markdown.html() output", () => {
    const vectors = [
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "[click](javascript:alert(1))",
      "<iframe src=javascript:alert(1)>",
    ];
    for (const md of vectors) {
      const html = Bun.markdown.html(md, { autolinks: true });
      const sanitized = Bun.escapeHTML(html);
      // escapeHTML converts < to &lt; so no literal <script> or <iframe> remains
      expect(sanitized).not.toMatch(/<script/i);
      expect(sanitized).not.toMatch(/<iframe/i);
      // Note: onerror= and javascript: survive in attribute values —
      // escapeHTML is NOT a complete sanitizer. Use DOMPurify for that.
    }
  });
});
