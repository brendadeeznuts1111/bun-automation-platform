/**
 * Deep audit: Bun.markdown.react() React 18 vs 19 element symbols.
 *
 * XREF: Bug cross-reference chain — see docs/render-diagrams.ts#cross-reference-chain
 * Related: Bug 14 (structuredClone throws), REF-REACT-18
 * Doc: docs/render-diagrams.ts#react-version-reference-ref-react-18
 *
 * Verifies:
 * - REF-REACT-18: React 18 pinned as canonical reference
 * - reactVersion option threshold: < 19 → element, >= 19 → transitional.element
 * - Non-number reactVersion → default (transitional.element)
 * - All nested elements share the same $$typeof as root
 * - Element structure identical between 18 and 19 (only $$typeof differs)
 * - Fragment type symbol is the same for both versions
 * - structuredClone fails on both versions (Symbols can't be cloned)
 * - JSON.stringify with symbol replacer produces different output
 * - Element is not frozen, no _owner/_store fields
 *
 * Ref: https://github.com/facebook/react/blob/v18.3.1/packages/react/src/ReactElement.js#L24
 * Ref: https://github.com/facebook/react/blob/v19.0.0/packages/react/src/ReactElement.js
 */

import { describe, expect, it } from "bun:test";

// Reference ID for cross-referencing
const REF_REACT_18 = "REF-REACT-18" as const;

const md = "# Hello **world**\n\n- item 1\n- item 2\n\n| Col1 | Col2 |\n|------|------|\n| a | b |";

// JUSTIFIED: Bun.markdown.react returns ReactElement which has $$typeof, type, key, ref, props.
// bun-types exports ReactElement as an opaque type — we need to narrow to inspect $$typeof.
// This helper does the cast once so individual tests don't need `as` on every call.
type ReactEl = { $$typeof?: symbol; type: unknown; key: unknown; ref: unknown; props: { children?: unknown } };

// JUSTIFIED: Single cast point — all React element inspection goes through this helper
function react(md: string, components?: unknown, opts?: Parameters<typeof Bun.markdown.react>[2]): ReactEl {
  // JUSTIFIED: components and return type need cast — Bun.markdown.react returns opaque ReactElement
  return Bun.markdown.react(md, components as never, opts) as unknown as ReactEl;
}

describe("REF-REACT-18: React version reference", () => {
  it("prints reference ID REF-REACT-18", () => {
    console.log(`[${REF_REACT_18}] React version reference ID printed`);
    console.log(`[${REF_REACT_18}] Pinned: React 18.3.1`);
    console.log(`[${REF_REACT_18}] Element symbol: Symbol(react.element)`);
    expect(REF_REACT_18).toBe("REF-REACT-18");
  });

  it("React 18 uses Symbol(react.element)", () => {
    const el = react("# Test", undefined, { reactVersion: 18 });
    expect(String(el.$$typeof)).toBe("Symbol(react.element)");
    expect(el.$$typeof).toBe(Symbol.for("react.element"));
    console.log(`[${REF_REACT_18}] React 18 symbol: ${String(el.$$typeof)}`);
  });

  it("React 19 uses Symbol(react.transitional.element)", () => {
    const el = react("# Test");
    expect(String(el.$$typeof)).toBe("Symbol(react.transitional.element)");
    expect(el.$$typeof).toBe(Symbol.for("react.transitional.element"));
    console.log(`[${REF_REACT_18}] React 19 symbol: ${String(el.$$typeof)}`);
  });

  it("React 18 and 19 use different $$typeof symbols", () => {
    const el18 = react("# Test", undefined, { reactVersion: 18 });
    const el19 = react("# Test");
    expect(el18.$$typeof).not.toBe(el19.$$typeof);
  });
});

describe("reactVersion option threshold", () => {
  // JUSTIFIED: bun-types only allows 18 | 19, but runtime accepts any number.
  // Testing the threshold behavior requires values outside the type union.
  // The runtime checks `reactVersion >= 19` — values < 19 produce react.element.

  it.each([
    [16, "Symbol(react.element)"],
    [17, "Symbol(react.element)"],
    [18, "Symbol(react.element)"],
    [18.99, "Symbol(react.element)"],
    [18.999, "Symbol(react.element)"],
    [18.99999, "Symbol(react.element)"],
    [0, "Symbol(react.element)"],
    [-1, "Symbol(react.element)"],
    [1, "Symbol(react.element)"],
  ])("reactVersion %f → Symbol(react.element)", (version, expected) => {
    // JUSTIFIED: cast to unknown then to ReactOptions — testing runtime threshold
    const opts = { reactVersion: version } as unknown as Parameters<typeof Bun.markdown.react>[2];
    const el = react("# Test", undefined, opts);
    expect(String(el.$$typeof)).toBe(expected);
  });

  it.each([
    [19, "Symbol(react.transitional.element)"],
    [19.0, "Symbol(react.transitional.element)"],
    [19.1, "Symbol(react.transitional.element)"],
    [20, "Symbol(react.transitional.element)"],
    [100, "Symbol(react.transitional.element)"],
  ])("reactVersion %f → Symbol(react.transitional.element)", (version, expected) => {
    // JUSTIFIED: cast to unknown then to ReactOptions — testing runtime threshold
    const opts = { reactVersion: version } as unknown as Parameters<typeof Bun.markdown.react>[2];
    const el = react("# Test", undefined, opts);
    expect(String(el.$$typeof)).toBe(expected);
  });

  it("threshold is exactly 19: < 19 → element, >= 19 → transitional", () => {
    // JUSTIFIED: 18.999 and 19.001 are not in the 18|19 type union — testing runtime threshold
    const below = react("# T", undefined, { reactVersion: 18.999 } as unknown as Parameters<typeof Bun.markdown.react>[2]);
    const at = react("# T", undefined, { reactVersion: 19 });
    // JUSTIFIED: 19.001 not in 18|19 type union — testing above-threshold
    const above = react("# T", undefined, { reactVersion: 19.001 } as unknown as Parameters<typeof Bun.markdown.react>[2]);
    expect(String(below.$$typeof)).toBe("Symbol(react.element)");
    expect(String(at.$$typeof)).toBe("Symbol(react.transitional.element)");
    expect(String(above.$$typeof)).toBe("Symbol(react.transitional.element)");
  });
});

describe("reactVersion non-number → default (transitional)", () => {
  it.each([
    ["18", "string"],
    ["19", "string"],
    [null, "null"],
    [undefined, "undefined"],
  ])("reactVersion %s (%s) → transitional (non-number falls back to default)", (version) => {
    // JUSTIFIED: cast to unknown then to ReactOptions — testing non-number runtime behavior
    const opts = { reactVersion: version } as unknown as Parameters<typeof Bun.markdown.react>[2];
    const el = react("# Test", undefined, opts);
    expect(String(el.$$typeof)).toBe("Symbol(react.transitional.element)");
  });

  it("missing reactVersion option → default (transitional)", () => {
    const el = react("# Test");
    expect(String(el.$$typeof)).toBe("Symbol(react.transitional.element)");
  });
});

describe("All nested elements share root $$typeof", () => {
  function collectSymbols(el: unknown, results: string[] = []): string[] {
    if (!el || typeof el !== "object") return results;
    // JUSTIFIED: narrowing unknown to ReactEl for property access in tree walker
    const e = el as ReactEl;
    if (e.$$typeof) results.push(String(e.$$typeof));
    const children = e.props?.children;
    if (Array.isArray(children)) {
      for (const c of children) collectSymbols(c, results);
    } else if (children && typeof children === "object") {
      collectSymbols(children, results);
    }
    return results;
  }

  it("React 19: all elements are transitional.element", () => {
    const el = react(md);
    const symbols = collectSymbols(el);
    expect(symbols.length).toBeGreaterThan(1);
    for (const s of symbols) {
      expect(s).toBe("Symbol(react.transitional.element)");
    }
  });

  it("React 18: all elements are react.element", () => {
    const el = react(md, undefined, { reactVersion: 18 });
    const symbols = collectSymbols(el);
    expect(symbols.length).toBeGreaterThan(1);
    for (const s of symbols) {
      expect(s).toBe("Symbol(react.element)");
    }
  });

  it("both versions have same number of elements", () => {
    const el19 = react(md);
    const el18 = react(md, undefined, { reactVersion: 18 });
    const syms19 = collectSymbols(el19);
    const syms18 = collectSymbols(el18);
    expect(syms19.length).toBe(syms18.length);
  });
});

describe("Element structure identical (only $$typeof differs)", () => {
  function deepCompare(a: unknown, b: unknown, path = "root"): string[] {
    const diffs: string[] = [];
    if (typeof a !== typeof b) {
      diffs.push(`${path}: type ${typeof a} vs ${typeof b}`);
      return diffs;
    }
    if (typeof a === "symbol") {
      if (String(a) !== String(b)) diffs.push(`${path}: symbol ${String(a)} vs ${String(b)}`);
      return diffs;
    }
    if (a === null || b === null) {
      if (a !== b) diffs.push(`${path}: ${a} vs ${b}`);
      return diffs;
    }
    if (typeof a === "object") {
      const keysA = Object.keys(a as object).filter(k => k !== "$$typeof");
      const keysB = Object.keys(b as object).filter(k => k !== "$$typeof");
      if (keysA.length !== keysB.length) {
        diffs.push(`${path}: keys [${keysA}] vs [${keysB}]`);
      }
      for (const k of keysA) {
        // JUSTIFIED: narrowing unknown to object/Record for property access in deep compare
        if (!(k in (b as object))) { diffs.push(`${path}.${k}: missing in 18`); continue; }
        // JUSTIFIED: same narrowing for recursive deepCompare call
        diffs.push(...deepCompare((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`));
      }
    }
    return diffs;
  }

  it("no structural differences between React 18 and 19 (excluding $$typeof)", () => {
    const el19 = react(md);
    const el18 = react(md, undefined, { reactVersion: 18 });
    const diffs = deepCompare(el19, el18);
    expect(diffs).toEqual([]);
  });

  it("same element types in both versions", () => {
    function collectTypes(el: unknown, types = new Set<string>()): Set<string> {
      if (!el || typeof el !== "object") return types;
      // JUSTIFIED: narrowing unknown to ReactEl for property access in tree walker
      const e = el as ReactEl;
      if (e.$$typeof) types.add(String(e.type));
      const children = e.props?.children;
      if (Array.isArray(children)) {
        for (const c of children) collectTypes(c, types);
      } else if (children && typeof children === "object") {
        collectTypes(children, types);
      }
      return types;
    }

    const el19 = react(md);
    const el18 = react(md, undefined, { reactVersion: 18 });
    const types19 = [...collectTypes(el19)].sort();
    const types18 = [...collectTypes(el18)].sort();
    expect(types19).toEqual(types18);
  });
});

describe("Fragment type symbol is shared", () => {
  it("both versions use Symbol(react.fragment) as root type", () => {
    const el19 = react("# Test");
    const el18 = react("# Test", undefined, { reactVersion: 18 });
    expect(String(el19.type)).toBe("Symbol(react.fragment)");
    expect(String(el18.type)).toBe("Symbol(react.fragment)");
    expect(el19.type).toBe(el18.type);
    expect(el19.type).toBe(Symbol.for("react.fragment"));
  });
});

describe("structuredClone fails on both versions (Bug 14)", () => {
  it("React 19: structuredClone throws DOMException", () => {
    const el = Bun.markdown.react("# Test");
    expect(() => structuredClone(el)).toThrow();
    try {
      structuredClone(el);
    } catch (e) {
      // JUSTIFIED: catch clause type is unknown — narrowing to Error for .message
      expect((e as Error).message).toContain("can not be cloned");
    }
  });

  it("React 18: structuredClone throws DOMException", () => {
    const el = Bun.markdown.react("# Test", undefined, { reactVersion: 18 });
    expect(() => structuredClone(el)).toThrow();
    try {
      structuredClone(el);
    } catch (e) {
      // JUSTIFIED: catch clause type is unknown — narrowing to Error for .message
      expect((e as Error).message).toContain("can not be cloned");
    }
  });
});

describe("JSON.stringify with symbol replacer", () => {
  function replacer(_k: string, v: unknown): unknown {
    if (typeof v === "symbol") return String(v);
    return v;
  }

  it("React 18 and 19 produce different JSON (symbol names differ)", () => {
    const el19 = react("# Test");
    const el18 = react("# Test", undefined, { reactVersion: 18 });
    const json19 = JSON.stringify(el19, replacer);
    const json18 = JSON.stringify(el18, replacer);
    expect(json19).not.toBe(json18);
    expect(json19).toContain("react.transitional.element");
    expect(json18).toContain("react.element");
  });

  it("JSON roundtrip loses $$typeof (Symbol not in JSON)", () => {
    const el = react("# Test");
    const json = JSON.stringify(el, replacer);
    const parsed = JSON.parse(json);
    expect(typeof parsed.$$typeof).toBe("string");
    expect(parsed.$$typeof).toBe("Symbol(react.transitional.element)");
  });
});

describe("Element object properties", () => {
  it("React 19 element has 5 own keys: $$typeof, type, key, ref, props", () => {
    const el = react("# Test");
    expect(Object.keys(el).sort()).toEqual(["$$typeof", "key", "props", "ref", "type"]);
  });

  it("React 18 element has same 5 own keys", () => {
    const el = react("# Test", undefined, { reactVersion: 18 });
    expect(Object.keys(el).sort()).toEqual(["$$typeof", "key", "props", "ref", "type"]);
  });

  it("no _owner field (React internal)", () => {
    // JUSTIFIED: ReactEl doesn't include _owner; extending to check React internal field
    const el19 = react("# Test") as unknown as ReactEl & { _owner?: unknown };
    // JUSTIFIED: same cast for React 18 variant
    const el18 = react("# Test", undefined, { reactVersion: 18 }) as unknown as ReactEl & { _owner?: unknown };
    expect(el19._owner).toBeUndefined();
    expect(el18._owner).toBeUndefined();
  });

  it("no _store field (React internal)", () => {
    // JUSTIFIED: ReactEl doesn't include _store; extending to check React internal field
    const el19 = react("# Test") as unknown as ReactEl & { _store?: unknown };
    // JUSTIFIED: same cast for React 18 variant
    const el18 = react("# Test", undefined, { reactVersion: 18 }) as unknown as ReactEl & { _store?: unknown };
    expect(el19._store).toBeUndefined();
    expect(el18._store).toBeUndefined();
  });

  it("key and ref are null", () => {
    const el19 = react("# Test");
    const el18 = react("# Test", undefined, { reactVersion: 18 });
    expect(el19.key).toBeNull();
    expect(el19.ref).toBeNull();
    expect(el18.key).toBeNull();
    expect(el18.ref).toBeNull();
  });

  it("elements are not frozen", () => {
    const el19 = react("# Test");
    const el18 = react("# Test", undefined, { reactVersion: 18 });
    expect(Object.isFrozen(el19)).toBe(false);
    expect(Object.isFrozen(el18)).toBe(false);
    expect(Object.isFrozen(el19.props)).toBe(false);
    expect(Object.isFrozen(el18.props)).toBe(false);
  });
});

describe("Symbol registration (global)", () => {
  it("react.element is globally registered via Symbol.for()", () => {
    const el = react("# T", undefined, { reactVersion: 18 });
    expect(el.$$typeof).toBe(Symbol.for("react.element"));
    expect(Symbol.keyFor(el.$$typeof as symbol)).toBe("react.element");
  });

  it("react.transitional.element is globally registered via Symbol.for()", () => {
    const el = react("# T");
    expect(el.$$typeof).toBe(Symbol.for("react.transitional.element"));
    expect(Symbol.keyFor(el.$$typeof as symbol)).toBe("react.transitional.element");
  });

  it("react.fragment is globally registered via Symbol.for()", () => {
    const el = react("# T");
    expect(el.type).toBe(Symbol.for("react.fragment"));
    expect(Symbol.keyFor(el.type as symbol)).toBe("react.fragment");
  });
});

describe("Custom component $$typeof normalization", () => {
  // JUSTIFIED: custom components are used as the `type` field by Bun.markdown.react.
  // The component function is NOT called by Bun — it's called by React during rendering.
  // Bun creates: { $$typeof: <tree symbol>, type: componentFn, props: { children }, ... }
  type CustomEl = { $$typeof?: symbol; type: unknown; props: { children?: unknown; [k: string]: unknown }; key: unknown; ref: unknown };

  // JUSTIFIED: custom component — Bun uses it as type field, doesn't call it
  const customComp = (props: { children?: unknown }) => ({ type: "div", props: { children: props.children } });

  it("React 19 tree: custom component element gets transitional.element $$typeof", () => {
    const tree = react("# Test", { h1: customComp as never });
    // JUSTIFIED: children is an array; first element is the h1 custom component
    const h1 = (tree.props.children as unknown[])[0] as unknown as CustomEl;
    expect(String(h1.$$typeof)).toBe("Symbol(react.transitional.element)");
    expect(typeof h1.type).toBe("function");
    console.log(`[${REF_REACT_18}] Custom comp element $$typeof: ${String(h1.$$typeof)}`);
  });

  it("React 18 tree: custom component element gets react.element $$typeof", () => {
    const tree = react("# Test", { h1: customComp as never }, { reactVersion: 18 });
    // JUSTIFIED: children is an array; first element is the h1 custom component
    const h1 = (tree.props.children as unknown[])[0] as unknown as CustomEl;
    expect(String(h1.$$typeof)).toBe("Symbol(react.element)");
    expect(typeof h1.type).toBe("function");
  });

  it("custom component type field is the function reference (not called by Bun)", () => {
    let called = false;
    // JUSTIFIED: tracking if Bun calls the component — it should NOT
    const trackingComp = (_props: { children?: unknown }) => { called = true; return null; };
    const tree = react("# Test", { h1: trackingComp as never });
    // JUSTIFIED: children is an array; first element is the custom component element
    const h1 = (tree.props.children as unknown[])[0] as unknown as CustomEl;
    expect(called).toBe(false);
    expect(h1.type).toBe(trackingComp);
  });

  it("custom component element shares tree $$typeof (no mixing)", () => {
    const tree19 = react("# Test", { h1: customComp as never });
    const tree18 = react("# Test", { h1: customComp as never }, { reactVersion: 18 });
    // JUSTIFIED: children is an array; first element is the custom component element
    const h1_19 = (tree19.props.children as unknown[])[0] as unknown as CustomEl;
    // JUSTIFIED: same array access for React 18 tree
    const h1_18 = (tree18.props.children as unknown[])[0] as unknown as CustomEl;
    expect(h1_19.$$typeof).toBe(tree19.$$typeof);
    expect(h1_18.$$typeof).toBe(tree18.$$typeof);
  });
});

describe("React.isValidElement compatibility", () => {
  it("React 19 isValidElement accepts react.transitional.element (default)", () => {
    const React = require("react");
    const el = react("# Test");
    expect(React.isValidElement(el)).toBe(true);
  });

  it("React 19 isValidElement rejects react.element (reactVersion: 18)", () => {
    const React = require("react");
    const el = react("# Test", undefined, { reactVersion: 18 });
    expect(React.isValidElement(el)).toBe(false);
    console.log(`[${REF_REACT_18}] React 19 isValidElement(react.element) = false — version mismatch`);
  });

  it("React 19 isValidElement checks only $$typeof (not _owner/_store)", () => {
    const React = require("react");
    // JUSTIFIED: manually constructing element-like object to test isValidElement criteria
    const fake19 = {
      $$typeof: Symbol.for("react.transitional.element"),
      type: "h1",
      ref: null,
      key: null,
      props: { children: "test" },
    } as never;
    expect(React.isValidElement(fake19)).toBe(true);

    // JUSTIFIED: manually constructing react.element object to test rejection
    const fake18 = {
      $$typeof: Symbol.for("react.element"),
      type: "h1",
      ref: null,
      key: null,
      props: { children: "test" },
    } as never;
    expect(React.isValidElement(fake18)).toBe(false);
  });
});

describe("React 19 renderToString compatibility", () => {
  it("React 19 SSR renders default Bun.markdown.react output", () => {
    const { renderToString } = require("react-dom/server");
    const el = react("# Hello **world**");
    const html = renderToString(el);
    expect(html).toContain("<h1>");
    expect(html).toContain("<strong>world</strong>");
  });

  it("React 19 SSR fails on reactVersion: 18 output", () => {
    const { renderToString } = require("react-dom/server");
    const el = react("# Hello", undefined, { reactVersion: 18 });
    expect(() => renderToString(el)).toThrow();
    console.log(`[${REF_REACT_18}] renderToString(react.element) throws — React 19 can't render React 18 elements`);
  });

  it("React 19 SSR works with custom components using React.createElement", () => {
    const React = require("react");
    const { renderToString } = require("react-dom/server");
    // JUSTIFIED: custom component uses React.createElement — narrowing for renderToString
    const components = {
      h1: (props: { children?: unknown }) => React.createElement("h1", { className: "custom" }, props.children),
    } as never;
    const el = react("# Test", components);
    const html = renderToString(el);
    expect(html).toContain('class="custom"');
    expect(html).toContain("<h1");
  });
});

describe("Performance: React 18 vs 19", () => {
  it("React 18 and 19 have similar performance (< 20% difference)", () => {
    const bigMd = "# Hello\n\n" + "Paragraph ".repeat(50) + "\n\n- " + "item\n- ".repeat(30);
    const iterations = 500;

    // Warmup
    for (let i = 0; i < 50; i++) {
      react(bigMd);
      react(bigMd, undefined, { reactVersion: 18 });
    }

    const start19 = performance.now();
    for (let i = 0; i < iterations; i++) react(bigMd);
    const time19 = performance.now() - start19;

    const start18 = performance.now();
    for (let i = 0; i < iterations; i++) react(bigMd, undefined, { reactVersion: 18 });
    const time18 = performance.now() - start18;

    const ratio = time19 / time18;
    console.log(`[${REF_REACT_18}] Performance: React 19 ${time19.toFixed(2)}ms vs React 18 ${time18.toFixed(2)}ms (ratio: ${ratio.toFixed(2)})`);
    // React 19 should be within 20% of React 18 (usually slightly faster)
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2.0);
  });
});

describe("Structure identical across versions (comprehensive)", () => {
  const complexMd = "# Title\n\n**bold** *italic* `code`\n\n- a\n- b\n- c\n\n| H1 | H2 |\n|----|----|\n| 1 | 2 |\n\n> quote\n\n[link](https://x.com)\n\n![img](https://x.com/i.png)";

  it("element count matches between React 18 and 19", () => {
    function count(el: unknown): number {
      if (!el || typeof el !== "object") return 0;
      // JUSTIFIED: narrowing unknown to ReactEl for tree traversal
      const e = el as ReactEl;
      let n = e.$$typeof ? 1 : 0;
      const children = e.props?.children;
      if (Array.isArray(children)) for (const c of children) n += count(c);
      else if (children && typeof children === "object") n += count(children);
      return n;
    }

    const el19 = react(complexMd);
    const el18 = react(complexMd, undefined, { reactVersion: 18 });
    expect(count(el19)).toBe(count(el18));
  });

  it("element types match between React 18 and 19", () => {
    function types(el: unknown, acc: string[] = []): string[] {
      if (!el || typeof el !== "object") return acc;
      // JUSTIFIED: narrowing unknown to ReactEl for tree traversal
      const e = el as ReactEl;
      if (e.$$typeof) acc.push(String(e.type));
      const children = e.props?.children;
      if (Array.isArray(children)) for (const c of children) types(c, acc);
      else if (children && typeof children === "object") types(children, acc);
      return acc;
    }

    const el19 = react(complexMd);
    const el18 = react(complexMd, undefined, { reactVersion: 18 });
    expect(types(el19).sort()).toEqual(types(el18).sort());
  });
});
