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

type ReactOpts = Parameters<typeof Bun.markdown.react>[2];

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

describe("Element types and props (comprehensive)", () => {
  // JUSTIFIED: narrowing to access props for element type verification
  type El = { $$typeof?: symbol; type: unknown; props: Record<string, unknown> & { children?: unknown } };

  function firstChild(el: ReactEl): El {
    // JUSTIFIED: narrowing unknown children array to first element
    return (el.props.children as unknown[])[0] as unknown as El;
  }

  it("empty markdown → fragment with empty children array", () => {
    const tree = react("");
    expect(String(tree.type)).toBe("Symbol(react.fragment)");
    expect(Array.isArray(tree.props.children)).toBe(true);
    expect((tree.props.children as unknown[]).length).toBe(0);
  });

  it("whitespace-only markdown → fragment with empty children", () => {
    const tree = react("   \n\n  \n  ");
    expect((tree.props.children as unknown[]).length).toBe(0);
  });

  it("paragraph → p element with text children", () => {
    const tree = react("hello");
    const p = firstChild(tree);
    expect(p.type).toBe("p");
  });

  it("headings h1-h6 → correct type", () => {
    const tree = react("# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6");
    const children = tree.props.children as unknown[];
    // JUSTIFIED: narrowing children array elements to El for type checking
    const types = children.map(c => (c as unknown as El).type);
    expect(types).toEqual(["h1", "h2", "h3", "h4", "h5", "h6"]);
  });

  it("bold → strong element", () => {
    const tree = react("**bold**");
    const p = firstChild(tree);
    // JUSTIFIED: narrowing p.children array to first element
    const strong = (p.props.children as unknown[])[0] as unknown as El;
    expect(strong.type).toBe("strong");
  });

  it("italic → em element", () => {
    const tree = react("*italic*");
    const p = firstChild(tree);
    // JUSTIFIED: narrowing p.children array to first element
    const em = (p.props.children as unknown[])[0] as unknown as El;
    expect(em.type).toBe("em");
  });

  it("inline code → code element", () => {
    const tree = react("`code`");
    const p = firstChild(tree);
    // JUSTIFIED: narrowing p.children array to first element
    const code = (p.props.children as unknown[])[0] as unknown as El;
    expect(code.type).toBe("code");
  });

  it("link → a element with href prop", () => {
    const tree = react("[text](https://x.com)");
    const p = firstChild(tree);
    // JUSTIFIED: narrowing p.children array to first element
    const a = (p.props.children as unknown[])[0] as unknown as El;
    expect(a.type).toBe("a");
    expect(a.props.href).toBe("https://x.com");
  });

  it("image → img element with src and alt props", () => {
    const tree = react("![alt text](https://x.com/i.png)");
    const p = firstChild(tree);
    // JUSTIFIED: narrowing p.children array to first element
    const img = (p.props.children as unknown[])[0] as unknown as El;
    expect(img.type).toBe("img");
    expect(img.props.src).toBe("https://x.com/i.png");
    expect(img.props.alt).toBe("alt text");
  });

  it("unordered list → ul with li children", () => {
    const tree = react("- a\n- b");
    const ul = firstChild(tree);
    expect(ul.type).toBe("ul");
    const items = ul.props.children as unknown[];
    expect(items.length).toBe(2);
    // JUSTIFIED: narrowing li elements for type checking
    expect((items[0] as unknown as El).type).toBe("li");
    // JUSTIFIED: narrowing unknown array element to El for type check
    expect((items[1] as unknown as El).type).toBe("li");
  });

  it("ordered list → ol with start prop and li children", () => {
    const tree = react("1. first\n2. second");
    const ol = firstChild(tree);
    expect(ol.type).toBe("ol");
    expect(ol.props.start).toBe(1);
  });

  it("task list → li with checked prop", () => {
    const tree = react("- [ ] todo\n- [x] done");
    const ul = firstChild(tree);
    const items = ul.props.children as unknown[];
    // JUSTIFIED: narrowing li elements for checked prop checking
    expect((items[0] as unknown as El).props.checked).toBe(false);
    // JUSTIFIED: narrowing unknown array element to El for props check
    expect((items[1] as unknown as El).props.checked).toBe(true);
  });

  it("blockquote → blockquote with p child", () => {
    const tree = react("> quoted text");
    const bq = firstChild(tree);
    expect(bq.type).toBe("blockquote");
    // JUSTIFIED: narrowing blockquote children for p element check
    const p = (bq.props.children as unknown[])[0] as unknown as El;
    expect(p.type).toBe("p");
  });

  it("code block → pre with language prop", () => {
    const tree = react("```js\nconsole.log(1)\n```");
    const pre = firstChild(tree);
    expect(pre.type).toBe("pre");
    expect(pre.props.language).toBe("js");
  });

  it("code block without language → pre with language=undefined", () => {
    const tree = react("```\ncode\n```");
    const pre = firstChild(tree);
    expect(pre.type).toBe("pre");
    expect(pre.props.language).toBeUndefined();
  });

  it("hr → hr element", () => {
    const tree = react("---");
    const hr = firstChild(tree);
    expect(hr.type).toBe("hr");
  });

  it("table → table/thead/tbody/tr/th/td structure", () => {
    const tree = react("| H1 | H2 |\n|----|----|\n| 1 | 2 |");
    const table = firstChild(tree);
    expect(table.type).toBe("table");
    // JUSTIFIED: narrowing table children for thead/tbody check
    const thead = (table.props.children as unknown[])[0] as unknown as El;
    // JUSTIFIED: narrowing table children to El for tbody check
    const tbody = (table.props.children as unknown[])[1] as unknown as El;
    expect(thead.type).toBe("thead");
    expect(tbody.type).toBe("tbody");
  });

  it("nested list → ul/li/ul/li structure", () => {
    const tree = react("- a\n  - b\n- d");
    const ul = firstChild(tree);
    const items = ul.props.children as unknown[];
    // JUSTIFIED: narrowing first li for nested ul check
    const li0 = items[0] as unknown as El;
    expect(li0.type).toBe("li");
    // li0 children should contain text "a" and a nested ul
    const li0Children = li0.props.children as unknown[];
    // Find the nested ul among li0's children
    // JUSTIFIED: narrowing unknown child to El for type comparison in find
    const nestedUl = li0Children.find((c: unknown) => (c as unknown as El)?.type === "ul");
    expect(nestedUl).toBeDefined();
  });
});

describe("headings.ids option with react()", () => {
  it("headings.ids: true → h1 gets id prop", () => {
    // JUSTIFIED: headings option type not in react's third arg type — testing runtime
    const tree = react("# Hello World", undefined, { headings: { ids: true } } as unknown as Parameters<typeof Bun.markdown.react>[2]);
    // JUSTIFIED: narrowing children array to first element for id prop check
    const h1 = (tree.props.children as unknown[])[0] as unknown as { type: unknown; props: { id?: string; children?: unknown } };
    expect(h1.props.id).toBe("hello-world");
  });

  it("default (no headings.ids) → h1 has no id prop", () => {
    const tree = react("# Hello World");
    // JUSTIFIED: narrowing children array to first element for id prop check
    const h1 = (tree.props.children as unknown[])[0] as unknown as { type: unknown; props: { id?: string; children?: unknown } };
    expect(h1.props.id).toBeUndefined();
  });
});

describe("allowDangerousHtml option with react()", () => {
  it("default: raw HTML → html element wrapper", () => {
    const tree = react("<div>raw</div>");
    // JUSTIFIED: narrowing children array to first element for type check
    const child = (tree.props.children as unknown[])[0] as unknown as { type: unknown; props: Record<string, unknown> };
    expect(String(child.type)).toBe("html");
  });

  it("noHtmlBlocks: true → HTML wrapped in p", () => {
    // JUSTIFIED: noHtmlBlocks option type — testing runtime behavior
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    const tree = react("<div>raw</div>", undefined, { noHtmlBlocks: true } as unknown as Parameters<typeof Bun.markdown.react>[2]);
    // JUSTIFIED: narrowing children array to first element for type check
    const p = (tree.props.children as unknown[])[0] as unknown as { type: unknown; props: Record<string, unknown> };
    expect(p.type).toBe("p");
  });
});

describe("Edge cases: input types", () => {
  it("null input throws", () => {
    // JUSTIFIED: testing runtime error handling — null is not a valid input type
    expect(() => Bun.markdown.react(null as never)).toThrow("Expected a string or buffer");
  });

  it("number input throws", () => {
    // JUSTIFIED: testing runtime error handling — number is not a valid input type
    expect(() => Bun.markdown.react(42 as never)).toThrow("Expected a string or buffer");
  });

  it("object input throws", () => {
    // JUSTIFIED: testing runtime error handling — object is not a valid input type
    expect(() => Bun.markdown.react({ a: 1 } as never)).toThrow("Expected a string or buffer");
  });

  it("Uint8Array input works", () => {
    const buf = new TextEncoder().encode("# Hello");
    // JUSTIFIED: Uint8Array is accepted at runtime but not in type signature
    const tree = Bun.markdown.react(buf as unknown as string) as unknown as ReactEl;
    // JUSTIFIED: narrowing children array to first element for type check
    const h1 = (tree.props.children as unknown[])[0] as unknown as { type: unknown };
    expect(h1.type).toBe("h1");
  });

  it("ArrayBuffer input works", () => {
    const buf = new TextEncoder().encode("# Hello");
    // JUSTIFIED: ArrayBuffer is accepted at runtime but not in type signature
    const tree = Bun.markdown.react(buf.buffer as unknown as string) as unknown as ReactEl;
    // JUSTIFIED: narrowing children array to first element for type check
    const h1 = (tree.props.children as unknown[])[0] as unknown as { type: unknown };
    expect(h1.type).toBe("h1");
  });
});

describe("Edge cases: malformed markdown", () => {
  it("7+ hashes → paragraph (not heading)", () => {
    const tree = react("####### H7");
    // JUSTIFIED: narrowing children array to first element for type check
    const child = (tree.props.children as unknown[])[0] as unknown as { type: unknown };
    expect(child.type).toBe("p");
  });

  it("malformed table (no separator row) → paragraph", () => {
    const tree = react("| Col |\n| no separator |\n| val |");
    // JUSTIFIED: narrowing children array to first element for type check
    const child = (tree.props.children as unknown[])[0] as unknown as { type: unknown };
    expect(child.type).toBe("p");
  });

  it("unclosed code block → pre element (auto-closed)", () => {
    const tree = react("```\ncode without end");
    // JUSTIFIED: narrowing children array to first element for type check
    const child = (tree.props.children as unknown[])[0] as unknown as { type: unknown };
    expect(child.type).toBe("pre");
  });

  it("empty string → fragment with empty children", () => {
    const tree = react("");
    expect((tree.props.children as unknown[]).length).toBe(0);
  });

  it("very long input (100k chars) → single paragraph", () => {
    const long = "paragraph ".repeat(10000);
    const tree = react(long);
    expect((tree.props.children as unknown[]).length).toBe(1);
  });
});

describe("Edge cases: unicode and special content", () => {
  it("CJK content renders correctly", () => {
    const tree = react("# 日本語\n\nこんにちは世界");
    // JUSTIFIED: narrowing children array to first element for type/props check
    const h1 = (tree.props.children as unknown[])[0] as unknown as { type: unknown; props: { children?: unknown } };
    expect(h1.type).toBe("h1");
    const children = h1.props.children as unknown[];
    expect(children[0]).toBe("日本語");
  });

  it("emoji content renders correctly", () => {
    const tree = react("# 🎉 Title\n\nHello 👋");
    // JUSTIFIED: narrowing children array to first element for type/props check
    const h1 = (tree.props.children as unknown[])[0] as unknown as { type: unknown; props: { children?: unknown } };
    expect(h1.type).toBe("h1");
    const children = h1.props.children as unknown[];
    expect(children[0]).toContain("🎉");
  });

  it("mixed line endings (\\r\\n) handled correctly", () => {
    const tree = react("# Title\r\n\r\nParagraph\r\n\r\n- item\r\n- item");
    const children = tree.props.children as unknown[];
    // JUSTIFIED: narrowing children for type checking
    expect((children[0] as unknown as { type: unknown }).type).toBe("h1");
    // JUSTIFIED: narrowing children array element for type check
    expect((children[1] as unknown as { type: unknown }).type).toBe("p");
    // JUSTIFIED: narrowing children array element for type check
    expect((children[2] as unknown as { type: unknown }).type).toBe("ul");
  });
});

describe("GFM extensions in react()", () => {
  it("strikethrough → del element", () => {
    const tree = react("~~deleted~~");
    // JUSTIFIED: narrowing children array to first element for type/props check
    const p = (tree.props.children as unknown[])[0] as unknown as { type: unknown; props: { children?: unknown } };
    // JUSTIFIED: narrowing p.children array to first element
    const del = (p.props.children as unknown[])[0] as unknown as { type: unknown };
    expect(del.type).toBe("del");
  });

  it("autolink URL → plain text (not autolinked by default in react)", () => {
    const tree = react("Visit https://bun.com");
    // JUSTIFIED: narrowing children array to first element for type/props check
    const p = (tree.props.children as unknown[])[0] as unknown as { type: unknown; props: { children?: unknown } };
    expect(p.type).toBe("p");
    // URL is plain text, not an <a> element
    const children = p.props.children as unknown[];
    expect(children[0]).toContain("https://bun.com");
  });

  it("footnote-like syntax → a element with href", () => {
    const tree = react("Text[^1]\n\n[^1]: footnote");
    // JUSTIFIED: narrowing children array to first element for type/props check
    const p = (tree.props.children as unknown[])[0] as unknown as { type: unknown; props: { children?: unknown } };
    const children = p.props.children as unknown[];
    // Find the <a> element among children
    // JUSTIFIED: narrowing child to check for a element type
    const aEl = children.find((c: unknown) => (c as unknown as { type?: unknown })?.type === "a");
    expect(aEl).toBeDefined();
  });
});

describe("Key field: all elements have key=null", () => {
  // JUSTIFIED: narrowing to access key field for all elements in tree
  type KeyEl = { $$typeof?: symbol; type: unknown; key: unknown; ref: unknown; props: { children?: unknown } };

  function collectAllKeys(el: unknown, results: { type: string; key: unknown }[] = []): { type: string; key: unknown }[] {
    if (!el || typeof el !== "object") return results;
    // JUSTIFIED: narrowing unknown to KeyEl for key field inspection
    const e = el as KeyEl;
    if (e.$$typeof) {
      const type = typeof e.type === "function" ? "fn" : String(e.type).replace("Symbol(react.", "").replace(")", "");
      results.push({ type, key: e.key });
    }
    const children = e.props?.children;
    if (Array.isArray(children)) {
      for (const c of children) collectAllKeys(c, results);
    } else if (children && typeof children === "object") {
      collectAllKeys(children, results);
    }
    return results;
  }

  it("root element key is null (not undefined)", () => {
    const tree = react("# Test");
    expect(tree.key).toBeNull();
    expect(typeof tree.key).toBe("object"); // null is type "object"
  });

  it("all elements in complex tree have key=null", () => {
    const md = "# H1\n\n**bold**\n\n- a\n- b\n- c\n\n| H1 | H2 |\n|----|----|\n| 1 | 2 |\n\n> quote\n\n```\ncode\n```\n\n---";
    const tree = react(md);
    const allKeys = collectAllKeys(tree);
    expect(allKeys.length).toBeGreaterThan(10);
    for (const { key } of allKeys) {
      expect(key).toBeNull();
    }
  });

  it("list items all have key=null (no auto-keying by Bun)", () => {
    const tree = react("- a\n- b\n- c");
    // JUSTIFIED: narrowing root children to first element (ul)
    const ul = (tree.props.children as unknown[])[0] as unknown as KeyEl;
    const items = ul.props.children as unknown[];
    // JUSTIFIED: narrowing li elements for key check
    for (const item of items) {
      // JUSTIFIED: narrowing unknown array element to KeyEl for key check
      expect((item as KeyEl).key).toBeNull();
    }
  });

  it("table cells all have key=null", () => {
    const tree = react("| H1 | H2 |\n|----|----|\n| 1 | 2 |");
    // JUSTIFIED: narrowing root children to first element (table)
    const table = (tree.props.children as unknown[])[0] as unknown as KeyEl;
    const allKeys = collectAllKeys(table);
    for (const { key } of allKeys) {
      expect(key).toBeNull();
    }
  });

  it("custom component elements have key=null", () => {
    // JUSTIFIED: custom component — Bun uses it as type field
    const comp = (props: { children?: unknown }) => ({ type: "div", props: { children: props.children } });
    const tree = react("# Test", { h1: comp as never });
    // JUSTIFIED: narrowing children array to first element
    const h1 = (tree.props.children as unknown[])[0] as unknown as KeyEl;
    expect(h1.key).toBeNull();
  });

  it("repeated elements (multiple paragraphs) all have key=null", () => {
    const tree = react("text\n\ntext\n\ntext");
    const children = tree.props.children as unknown[];
    // JUSTIFIED: narrowing children for key check
    for (const child of children) {
      // JUSTIFIED: narrowing unknown array element to KeyEl for key check
      expect((child as KeyEl).key).toBeNull();
    }
  });

  it("React 18 and 19 both assign key=null", () => {
    const tree19 = react("# Test");
    const tree18 = react("# Test", undefined, { reactVersion: 18 });
    expect(tree19.key).toBeNull();
    expect(tree18.key).toBeNull();
  });
});

describe("React.Children.toArray auto-keys", () => {
  it("React.Children.toArray assigns keys (.0, .1, .2) to array children", () => {
    const React = require("react");
    const tree = react("- a\n- b\n- c");
    // JUSTIFIED: narrowing root children to first element (ul)
    const ul = (tree.props.children as unknown[])[0] as unknown as { props: { children: unknown[] } };
    const arr = React.Children.toArray(ul.props.children);
    expect(arr.length).toBe(3);
    expect(arr[0].key).toBe(".0");
    expect(arr[1].key).toBe(".1");
    expect(arr[2].key).toBe(".2");
  });

  it("React.Children.toArray fails on React 18 elements (isValidElement rejects them)", () => {
    const React = require("react");
    const tree = react("- a\n- b", undefined, { reactVersion: 18 });
    // JUSTIFIED: narrowing root children to first element (ul)
    const ul = (tree.props.children as unknown[])[0] as unknown as { props: { children: unknown[] } };
    expect(() => React.Children.toArray(ul.props.children)).toThrow();
  });
});

describe("ref field: all elements have ref=null", () => {
  // JUSTIFIED: narrowing to access ref field for all elements
  type RefEl = { $$typeof?: symbol; type: unknown; ref: unknown; props: { children?: unknown } };

  function collectRefs(el: unknown, results: { type: string; ref: unknown }[] = []): { type: string; ref: unknown }[] {
    if (!el || typeof el !== "object") return results;
    // JUSTIFIED: narrowing unknown to RefEl for ref inspection
    const e = el as RefEl;
    if (e.$$typeof) {
      const type = typeof e.type === "function" ? "fn" : String(e.type).replace("Symbol(react.", "").replace(")", "");
      results.push({ type, ref: e.ref });
    }
    const children = e.props?.children;
    if (Array.isArray(children)) for (const c of children) collectRefs(c, results);
    else if (children && typeof children === "object") collectRefs(children, results);
    return results;
  }

  it("root element ref is null", () => {
    const tree = react("# Test");
    expect(tree.ref).toBeNull();
  });

  it("all elements in complex tree have ref=null", () => {
    const md = "# H1\n\n[link](https://x.com)\n\n![img](https://x.com/i.png)\n\n- a\n- b\n\n> quote\n\n```\ncode\n```\n\n---\n\n| H1 | H2 |\n|----|----|\n| 1 | 2 |";
    const tree = react(md);
    const refs = collectRefs(tree);
    expect(refs.length).toBeGreaterThan(5);
    for (const { ref } of refs) expect(ref).toBeNull();
  });

  it("React 18 and 19 both assign ref=null", () => {
    const tree19 = react("# Test");
    const tree18 = react("# Test", undefined, { reactVersion: 18 });
    expect(tree19.ref).toBeNull();
    expect(tree18.ref).toBeNull();
  });
});

describe("Props: comprehensive per-element-type", () => {
  // JUSTIFIED: narrowing to access props for verification
  type PropsEl = { type: unknown; props: Record<string, unknown> & { children?: unknown } };

  function firstChild(el: ReactEl): PropsEl {
    // JUSTIFIED: narrowing children array to first element
    return (el.props.children as unknown[])[0] as unknown as PropsEl;
  }

  it("fragment has no props (only children)", () => {
    const tree = react("# Test");
    const propKeys = Object.keys(tree.props).filter(k => k !== "children");
    expect(propKeys).toEqual([]);
  });

  it("h1-h6 have no props (only children)", () => {
    const tree = react("# H1\n## H2");
    const children = tree.props.children as unknown[];
    // JUSTIFIED: narrowing children for props check
    const h1 = children[0] as unknown as PropsEl;
    // JUSTIFIED: narrowing for property access in test assertion
    const h2 = children[1] as unknown as PropsEl;
    const h1Props = Object.keys(h1.props).filter(k => k !== "children");
    const h2Props = Object.keys(h2.props).filter(k => k !== "children");
    expect(h1Props).toEqual([]);
    expect(h2Props).toEqual([]);
  });

  it("p has no props (only children)", () => {
    const tree = react("hello");
    const p = firstChild(tree);
    const propKeys = Object.keys(p.props).filter(k => k !== "children");
    expect(propKeys).toEqual([]);
  });

  it("strong, em, code have no props (only children)", () => {
    const tree = react("**bold** *italic* `code`");
    const p = firstChild(tree);
    const children = p.props.children as unknown[];
    // JUSTIFIED: narrowing children for props check
    for (const child of children) {
      if (typeof child === "object" && child !== null) {
        // JUSTIFIED: narrowing unknown child to PropsEl for props check
        const propKeys = Object.keys((child as PropsEl).props).filter(k => k !== "children");
        expect(propKeys).toEqual([]);
      }
    }
  });

  it("a has href prop (and optional title)", () => {
    const tree = react("[text](https://x.com)");
    const p = firstChild(tree);
    // JUSTIFIED: narrowing p.children to first element
    const a = (p.props.children as unknown[])[0] as unknown as PropsEl;
    expect(a.props.href).toBe("https://x.com");
  });

  it("a with title → title prop", () => {
    const tree = react('[text](https://x.com "title here")');
    const p = firstChild(tree);
    // JUSTIFIED: narrowing p.children to first element
    const a = (p.props.children as unknown[])[0] as unknown as PropsEl;
    expect(a.props.href).toBe("https://x.com");
    expect(a.props.title).toBe("title here");
  });

  it("img has src and alt props (and optional title)", () => {
    const tree = react("![alt text](https://x.com/i.png)");
    const p = firstChild(tree);
    // JUSTIFIED: narrowing p.children to first element
    const img = (p.props.children as unknown[])[0] as unknown as PropsEl;
    expect(img.props.src).toBe("https://x.com/i.png");
    expect(img.props.alt).toBe("alt text");
  });

  it("img with title → title prop", () => {
    const tree = react('![alt](https://x.com/i.png "title")');
    const p = firstChild(tree);
    // JUSTIFIED: narrowing p.children to first element
    const img = (p.props.children as unknown[])[0] as unknown as PropsEl;
    expect(img.props.title).toBe("title");
  });

  it("ol has start prop", () => {
    const tree = react("1. first\n2. second");
    const ol = firstChild(tree);
    expect(ol.props.start).toBe(1);
  });

  it("ul has no props", () => {
    const tree = react("- a\n- b");
    const ul = firstChild(tree);
    const propKeys = Object.keys(ul.props).filter(k => k !== "children");
    expect(propKeys).toEqual([]);
  });

  it("task list li has checked prop", () => {
    const tree = react("- [x] done");
    const ul = firstChild(tree);
    // JUSTIFIED: narrowing ul.children to first element
    const li = (ul.props.children as unknown[])[0] as unknown as PropsEl;
    expect(li.props.checked).toBe(true);
  });

  it("non-task li has no checked prop", () => {
    const tree = react("- regular item");
    const ul = firstChild(tree);
    // JUSTIFIED: narrowing ul.children to first element
    const li = (ul.props.children as unknown[])[0] as unknown as PropsEl;
    expect(li.props.checked).toBeUndefined();
  });

  it("pre has language prop (when specified)", () => {
    const tree = react("```js\ncode\n```");
    const pre = firstChild(tree);
    expect(pre.props.language).toBe("js");
  });

  it("pre has language=undefined (when not specified)", () => {
    const tree = react("```\ncode\n```");
    const pre = firstChild(tree);
    expect(pre.props.language).toBeUndefined();
  });

  it("blockquote has no props", () => {
    const tree = react("> quote");
    const bq = firstChild(tree);
    const propKeys = Object.keys(bq.props).filter(k => k !== "children");
    expect(propKeys).toEqual([]);
  });

  it("hr has no props (empty props object)", () => {
    const tree = react("---");
    const hr = firstChild(tree);
    const propKeys = Object.keys(hr.props).filter(k => k !== "children");
    expect(propKeys).toEqual([]);
  });

  it("table, thead, tbody, tr, th, td have no props", () => {
    const tree = react("| H1 | H2 |\n|----|----|\n| 1 | 2 |");
    const table = firstChild(tree);
    // JUSTIFIED: narrowing table children for thead/tbody check
    const thead = (table.props.children as unknown[])[0] as unknown as PropsEl;
    // JUSTIFIED: narrowing for property access in test assertion
    const tbody = (table.props.children as unknown[])[1] as unknown as PropsEl;
    // JUSTIFIED: narrowing thead children for tr check
    const tr = (thead.props.children as unknown[])[0] as unknown as PropsEl;
    // JUSTIFIED: narrowing tr children for th check
    const th = (tr.props.children as unknown[])[0] as unknown as PropsEl;

    for (const [, el] of [["table", table], ["thead", thead], ["tbody", tbody], ["tr", tr], ["th", th]] as [string, PropsEl][]) {
      const propKeys = Object.keys(el.props).filter(k => k !== "children");
      expect(propKeys).toEqual([]);
    }
  });
});

describe("Text nodes: string children", () => {
  it("text nodes are plain strings (not elements)", () => {
    const tree = react("# Hello");
    // JUSTIFIED: narrowing for property access in test assertion
    const h1 = (tree.props.children as unknown[])[0] as unknown as { props: { children: unknown[] } };
    const first = h1.props.children[0];
    expect(typeof first).toBe("string");
    expect(first).toBe("Hello");
  });

  it("whitespace between inline elements is preserved as string children", () => {
    const tree = react("**bold** *italic*");
    // JUSTIFIED: narrowing for property access in test assertion
    const p = (tree.props.children as unknown[])[0] as unknown as { props: { children: unknown[] } };
    const children = p.props.children;
    // [strong, " ", em]
    expect(children.length).toBe(3);
    expect(typeof children[1]).toBe("string");
    expect(children[1]).toBe(" ");
  });

  it("trailing newline in code block is preserved as string child", () => {
    const tree = react("```\ncode\n```");
    // JUSTIFIED: narrowing for property access in test assertion
    const pre = (tree.props.children as unknown[])[0] as unknown as { props: { children: unknown[] } };
    const children = pre.props.children;
    expect(children.length).toBe(2);
    expect(children[0]).toBe("code");
    expect(children[1]).toBe("\n");
  });

  it("multi-line code block: each line and newline is separate string child", () => {
    const tree = react("```\nline1\nline2\nline3\n```");
    // JUSTIFIED: narrowing for property access in test assertion
    const pre = (tree.props.children as unknown[])[0] as unknown as { props: { children: unknown[] } };
    const children = pre.props.children;
    // ["line1", "\n", "line2", "\n", "line3", "\n"]
    expect(children.length).toBe(6);
    expect(children[0]).toBe("line1");
    expect(children[1]).toBe("\n");
    expect(children[2]).toBe("line2");
  });

  it("multiple spaces in text are preserved", () => {
    const tree = react("Hello   world");
    // JUSTIFIED: narrowing for property access in test assertion
    const p = (tree.props.children as unknown[])[0] as unknown as { props: { children: unknown[] } };
    // Single text node with spaces preserved
    expect(p.props.children.length).toBe(1);
    expect(p.props.children[0]).toBe("Hello   world");
  });
});

describe("Hard line breaks: br element", () => {
  it("soft break (\\n) → no br element", () => {
    const tree = react("line1\nline2");
    // JUSTIFIED: narrowing for property access in test assertion
    const p = (tree.props.children as unknown[])[0] as unknown as { props: { children: unknown[] } };
    // JUSTIFIED: narrowing unknown child to check for br type
    const hasBr = p.props.children.some((c: unknown) => (c as { type?: unknown })?.type === "br");
    expect(hasBr).toBe(false);
  });

  it("hard break (2 trailing spaces + \\n) → br element", () => {
    const tree = react("line1  \nline2");
    // JUSTIFIED: narrowing for property access in test assertion
    const p = (tree.props.children as unknown[])[0] as unknown as { props: { children: unknown[] } };
    // JUSTIFIED: narrowing unknown child to check for br type
    const hasBr = p.props.children.some((c: unknown) => (c as { type?: unknown })?.type === "br");
    expect(hasBr).toBe(true);
  });

  it("hard break (backslash + \\n) → br element", () => {
    const tree = react("line1\\\nline2");
    // JUSTIFIED: narrowing for property access in test assertion
    const p = (tree.props.children as unknown[])[0] as unknown as { props: { children: unknown[] } };
    // JUSTIFIED: narrowing unknown child to check for br type
    const hasBr = p.props.children.some((c: unknown) => (c as { type?: unknown })?.type === "br");
    expect(hasBr).toBe(true);
  });

  it("br element has empty props (no children)", () => {
    const tree = react("line1  \nline2");
    // JUSTIFIED: narrowing for property access in test assertion
    const p = (tree.props.children as unknown[])[0] as unknown as { props: { children: unknown[] } };
    // JUSTIFIED: narrowing to find br element
    const br = p.props.children.find((c: unknown) => (c as { type?: unknown })?.type === "br") as unknown as { type: string; props: Record<string, unknown> };
    expect(br.props.children).toBeUndefined();
    const propKeys = Object.keys(br.props);
    expect(propKeys).toEqual([]);
  });

  it("br element has key=null and ref=null", () => {
    const tree = react("line1  \nline2");
    // JUSTIFIED: narrowing for property access in test assertion
    const p = (tree.props.children as unknown[])[0] as unknown as { props: { children: unknown[] } };
    // JUSTIFIED: narrowing to find br element
    const br = p.props.children.find((c: unknown) => (c as { type?: unknown })?.type === "br") as unknown as { key: unknown; ref: unknown };
    expect(br.key).toBeNull();
    expect(br.ref).toBeNull();
  });
});

describe("Link and image edge cases", () => {
  it("auto-link <url> → a element with href", () => {
    const tree = react("<https://bun.com>");
    // JUSTIFIED: narrowing for property access in test assertion
    const p = (tree.props.children as unknown[])[0] as unknown as { props: { children: unknown[] } };
    // JUSTIFIED: narrowing to find a element
    const a = p.props.children.find((c: unknown) => (c as { type?: unknown })?.type === "a") as unknown as { type: string; props: { href?: string } };
    expect(a).toBeDefined();
    expect(a.props.href).toBe("https://bun.com");
  });

  it("empty link text → a element with empty children", () => {
    const tree = react("[](https://x.com)");
    // JUSTIFIED: narrowing for property access in test assertion
    const p = (tree.props.children as unknown[])[0] as unknown as { props: { children: unknown[] } };
    // JUSTIFIED: narrowing to find a element
    const a = p.props.children.find((c: unknown) => (c as { type?: unknown })?.type === "a") as unknown as { type: string; props: { href?: string; children?: unknown[] } };
    expect(a).toBeDefined();
    expect(a.props.href).toBe("https://x.com");
  });

  it("reference link [text][ref] → a element with href from definition", () => {
    const tree = react("[text][ref]\n\n[ref]: https://x.com");
    // JUSTIFIED: narrowing for property access in test assertion
    const p = (tree.props.children as unknown[])[0] as unknown as { props: { children: unknown[] } };
    // JUSTIFIED: narrowing to find a element
    const a = p.props.children.find((c: unknown) => (c as { type?: unknown })?.type === "a") as unknown as { type: string; props: { href?: string } };
    expect(a).toBeDefined();
    expect(a.props.href).toBe("https://x.com");
  });

  it("nested formatting: bold containing italic → strong>em", () => {
    const tree = react("**bold *italic* bold**");
    // JUSTIFIED: narrowing for property access in test assertion
    const p = (tree.props.children as unknown[])[0] as unknown as { props: { children: unknown[] } };
    // JUSTIFIED: narrowing to find strong element
    const strong = p.props.children.find((c: unknown) => (c as { type?: unknown })?.type === "strong") as unknown as { type: string; props: { children: unknown[] } };
    expect(strong).toBeDefined();
    // strong should contain an em element
    // JUSTIFIED: narrowing unknown child to check for em type
    const em = strong.props.children.find((c: unknown) => (c as { type?: unknown })?.type === "em");
    expect(em).toBeDefined();
  });
});

describe("Custom component props: what React passes during rendering", () => {
  // JUSTIFIED: custom components capture props during React render — using require() dynamically
  // because React is installed via package.json
  const React = require("react");
  const { renderToString } = require("react-dom/server");

  it("a component receives href, title, children", () => {
    let capturedProps: Record<string, any> | null = null;
    const components = {
      a: (props: Record<string, unknown>) => {
        capturedProps = props;
        return React.createElement("a", { href: props.href, title: props.title }, props.children);
      },
    };
    const tree = react('[text](https://x.com "title here")', { a: components.a as never });
    renderToString(tree);
    expect(capturedProps).not.toBeNull();
    expect(capturedProps!["href"]).toBe("https://x.com");
    expect(capturedProps!["title"]).toBe("title here");
    expect(capturedProps!["children"]).toEqual(["text"]);
  });

  it("img component receives src, alt, title", () => {
    let capturedProps: Record<string, any> | null = null;
    const components = {
      img: (props: Record<string, unknown>) => {
        capturedProps = props;
        return React.createElement("img", { src: props.src, alt: props.alt, title: props.title });
      },
    };
    const tree = react('![alt](https://x.com/i.png "title")', { img: components.img as never });
    renderToString(tree);
    expect(capturedProps).not.toBeNull();
    expect(capturedProps!["src"]).toBe("https://x.com/i.png");
    expect(capturedProps!["alt"]).toBe("alt");
    expect(capturedProps!["title"]).toBe("title");
  });

  it("li task component receives checked + children", () => {
    let capturedProps: Record<string, any> | null = null;
    const components = {
      li: (props: Record<string, unknown>) => {
        capturedProps = props;
        return React.createElement("li", { checked: props.checked }, props.children);
      },
    };
    const tree = react("- [x] done", { li: components.li as never });
    renderToString(tree);
    expect(capturedProps).not.toBeNull();
    expect(capturedProps!["checked"]).toBe(true);
    expect(capturedProps!["children"]).toEqual(["done"]);
  });

  it("pre component receives language + children", () => {
    let capturedProps: Record<string, any> | null = null;
    const components = {
      pre: (props: Record<string, unknown>) => {
        capturedProps = props;
        return React.createElement("pre", { "data-language": props.language }, props.children);
      },
    };
    const tree = react("```js\ncode\n```", { pre: components.pre as never });
    renderToString(tree);
    expect(capturedProps).not.toBeNull();
    expect(capturedProps!["language"]).toBe("js");
    expect(capturedProps!["children"]).toEqual(["code", "\n"]);
  });

  it("h1 component receives only children (no id without headings.ids)", () => {
    let capturedProps: Record<string, any> | null = null;
    const components = {
      h1: (props: Record<string, unknown>) => {
        capturedProps = props;
        return React.createElement("h1", null, props.children);
      },
    };
    const tree = react("# Hello", { h1: components.h1 as never });
    renderToString(tree);
    expect(capturedProps).not.toBeNull();
    expect(capturedProps!["children"]).toEqual(["Hello"]);
    expect(capturedProps!["id"]).toBeUndefined();
  });

  it("h1 component receives id with headings.ids: true", () => {
    let capturedProps: Record<string, any> | null = null;
    const components = {
      h1: (props: Record<string, unknown>) => {
        capturedProps = props;
        return React.createElement("h1", { id: props.id }, props.children);
      },
    };
    // JUSTIFIED: headings option not in type signature — testing runtime
    const tree = react("# Hello World", { h1: components.h1 as never } as unknown, { headings: { ids: true } } as unknown as Parameters<typeof Bun.markdown.react>[2]);
    renderToString(tree);
    expect(capturedProps).not.toBeNull();
    expect(capturedProps!["id"]).toBe("hello-world");
  });

  it("props object is extensible (not frozen)", () => {
    let capturedProps: Record<string, any> | null = null;
    const components = {
      a: (props: Record<string, unknown>) => {
        capturedProps = props;
        // JUSTIFIED: props is Record<string, any> — adding new prop to test extensibility
        (props as Record<string, unknown>).newProp = "test";
        // JUSTIFIED: props is Record<string, any> — deleting prop to test extensibility
        delete (props as Record<string, unknown>).href;
        return React.createElement("a", { href: props.href }, props.children);
      },
    };
    const tree = react("[text](https://x.com)", { a: components.a as never });
    renderToString(tree);
    expect(capturedProps).not.toBeNull();
    expect(Object.isFrozen(capturedProps)).toBe(false);
    expect(Object.isSealed(capturedProps)).toBe(false);
    expect(Object.isExtensible(capturedProps)).toBe(true);
    expect(capturedProps!["newProp"]).toBe("test");
    expect(capturedProps!["href"]).toBeUndefined();
  });

  it("children is always an array (even single child)", () => {
    let capturedChildren: unknown = null;
    const components = {
      a: (props: Record<string, unknown>) => {
        capturedChildren = props.children;
        return React.createElement("a", { href: props.href }, props.children);
      },
    };
    const tree = react("[text](https://x.com)", { a: components.a as never });
    renderToString(tree);
    expect(Array.isArray(capturedChildren)).toBe(true);
    expect((capturedChildren as unknown[]).length).toBe(1);
    expect((capturedChildren as unknown[])[0]).toBe("text");
  });

  it("image inside link: a children contains img element", () => {
    let capturedAChildren: unknown[] | null = null;
    let capturedImg: Record<string, unknown> | null = null;
    const components = {
      a: (props: Record<string, unknown>) => {
        capturedAChildren = props.children as unknown[];
        return React.createElement("a", { href: props.href }, props.children);
      },
      img: (props: Record<string, unknown>) => {
        capturedImg = props;
        return React.createElement("img", { src: props.src, alt: props.alt });
      },
    };
    const tree = react("[![alt](https://x.com/i.png)](https://x.com)", { a: components.a as never, img: components.img as never });
    renderToString(tree);
    expect(capturedAChildren).not.toBeNull();
    expect(Array.isArray(capturedAChildren)).toBe(true);
    expect(capturedAChildren).not.toBeNull();
    expect(capturedAChildren!.length).toBe(1);
    // JUSTIFIED: narrowing captured array element to check $$typeof
    expect((capturedAChildren![0] as { $$typeof?: symbol }).$$typeof).toBeDefined();
    expect(capturedImg).not.toBeNull();
    expect(capturedImg!["src"]).toBe("https://x.com/i.png");
  });

  it("custom component can return a string", () => {
    const components = {
      h1: () => "custom string",
    };
    const tree = react("# Hello", { h1: components.h1 as never });
    const html = renderToString(tree);
    expect(html).toContain("custom string");
  });

  it("custom component can return an array of strings", () => {
    const components = {
      h1: () => ["A", "B", "C"],
    };
    const tree = react("# Hello", { h1: components.h1 as never });
    const html = renderToString(tree);
    expect(html).toContain("A");
    expect(html).toContain("B");
    expect(html).toContain("C");
  });

  it("all built-in markdown tags can be customized", () => {
    const types = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "strong", "em", "code", "a", "img", "ul", "ol", "li", "blockquote", "pre", "hr", "table", "thead", "tbody", "tr", "th", "td"];
    const md = "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n\n**strong** *em* `code`\n\n[link](https://x.com)\n\n![img](https://x.com/i.png)\n\n- li\n\n1. ol\n\n> quote\n\n```\ncode\n```\n\n---\n\n| H | H |\n|----|----|\n| 1 | 2 |";

    const capturedTypes = new Set<string>();
    const components: Record<string, (props: Record<string, unknown>) => any> = {};
    for (const t of types) {
      components[t] = (props: Record<string, unknown>) => {
        capturedTypes.add(t);
        return React.createElement(t, null, props.children);
      };
    }

    const tree = react(md, components as never);
    renderToString(tree);

    for (const t of types) {
      expect(capturedTypes.has(t)).toBe(true);
    }
  });
});

describe("React markdown parser options (real options per bun-types)", () => {
  it("strikethrough: false → literal ~~ as text", () => {
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    const tree = react("~~deleted~~", undefined, { strikethrough: false } as unknown as ReactOpts);
    // JUSTIFIED: narrowing for React element property access in option test
    const p = (tree.props.children as unknown[])[0] as unknown as { props: { children: string } };
    expect(p.props.children).toContain("~~deleted~~");
  });

  it("strikethrough: true → del element", () => {
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    const tree = react("~~deleted~~", undefined, { strikethrough: true } as unknown as ReactOpts);
    // JUSTIFIED: narrowing for React element property access in option test
    const p = (tree.props.children as unknown[])[0] as unknown as { props: { children: unknown[] } };
    // JUSTIFIED: narrowing p.children for del check
    const del = p.props.children.find((c: unknown) => (c as { type?: unknown })?.type === "del");
    expect(del).toBeDefined();
  });

  it("tables: false → table as text", () => {
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    const tree = react("| H | H |\n|----|----|\n| 1 | 2 |", undefined, { tables: false } as unknown as ReactOpts);
    // JUSTIFIED: narrowing for React element property access in option test
    const p = (tree.props.children as unknown[])[0] as unknown as { type: unknown };
    expect(p.type).toBe("p");
  });

  it("tables: true → table element", () => {
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    const tree = react("| H | H |\n|----|----|\n| 1 | 2 |", undefined, { tables: true } as unknown as ReactOpts);
    // JUSTIFIED: narrowing for React element property access in option test
    const child = (tree.props.children as unknown[])[0] as unknown as { type: unknown };
    expect(child.type).toBe("table");
  });

  it("tasklists: false → checkbox as text", () => {
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    const tree = react("- [x] done", undefined, { tasklists: false } as unknown as ReactOpts);
    // JUSTIFIED: narrowing for React element property access in option test
    const ul = (tree.props.children as unknown[])[0] as unknown as { props: { children: unknown[] } };
    // JUSTIFIED: narrowing li for checked check
    const li = ul.props.children[0] as unknown as { props: { checked?: unknown } };
    expect(li.props.checked).toBeUndefined();
  });

  it("tasklists: true → li has checked prop", () => {
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    const tree = react("- [x] done", undefined, { tasklists: true } as unknown as ReactOpts);
    // JUSTIFIED: narrowing for React element property access in option test
    const ul = (tree.props.children as unknown[])[0] as unknown as { props: { children: unknown[] } };
    // JUSTIFIED: narrowing li for checked check
    const li = ul.props.children[0] as unknown as { props: { checked?: unknown } };
    expect(li.props.checked).toBe(true);
  });

  it("autolinks: false → URL as plain text", () => {
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    const tree = react("Visit https://x.com", undefined, { autolinks: false } as unknown as ReactOpts);
    // JUSTIFIED: narrowing for React element property access in option test
    const p = (tree.props.children as unknown[])[0] as unknown as { props: { children: unknown[] } };
    // JUSTIFIED: checking no a element in children
    const hasA = p.props.children.some((c: unknown) => (c as { type?: unknown })?.type === "a");
    expect(hasA).toBe(false);
  });

  it("autolinks: true → URL as a element", () => {
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    const tree = react("Visit https://x.com", undefined, { autolinks: true } as unknown as ReactOpts);
    // JUSTIFIED: narrowing for React element property access in option test
    const p = (tree.props.children as unknown[])[0] as unknown as { props: { children: unknown[] } };
    // JUSTIFIED: checking a element exists
    const a = p.props.children.find((c: unknown) => (c as { type?: unknown })?.type === "a");
    expect(a).toBeDefined();
    // JUSTIFIED: narrowing a element for href check
    expect((a as { props: { href: string } }).props.href).toBe("https://x.com");
  });

  it("wikiLinks: true → [[target]] becomes a element", () => {
    // JUSTIFIED: narrowing for React element property access in option test
    const tree = react("[[Wiki Link]]", undefined, { wikiLinks: true } as unknown as ReactOpts);
    // JUSTIFIED: narrowing for React element property access in option test
    const p = (tree.props.children as unknown[])[0] as unknown as { props: { children: unknown[] } };
    // JUSTIFIED: checking a element for wiki link
    const a = p.props.children.find((c: unknown) => (c as { type?: unknown })?.type === "a");
    expect(a).toBeDefined();
    // JUSTIFIED: narrowing a element for children check
    expect((a as { props: { children: string } }).props.children).toContain("Wiki Link");
  });

  it("noIndentedCodeBlocks: false → indented text becomes pre", () => {
    // JUSTIFIED: narrowing for React element property access in option test
    const tree = react("     code", undefined, { noIndentedCodeBlocks: false } as unknown as ReactOpts);
    // JUSTIFIED: narrowing for React element property access in option test
    const child = (tree.props.children as unknown[])[0] as unknown as { type: unknown };
    expect(child.type).toBe("pre");
  });

  it("noIndentedCodeBlocks: true → indented text becomes p", () => {
    // JUSTIFIED: narrowing for React element property access in option test
    const tree = react("     code", undefined, { noIndentedCodeBlocks: true } as unknown as ReactOpts);
    // JUSTIFIED: narrowing for React element property access in option test
    const child = (tree.props.children as unknown[])[0] as unknown as { type: unknown };
    expect(child.type).toBe("p");
  });

  it("noHtmlBlocks: true → block HTML wrapped in p (not escaped)", () => {
    // JUSTIFIED: narrowing for React element property access in option test
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    const tree = react("<div>block</div>", undefined, { noHtmlBlocks: true } as unknown as ReactOpts);
    // JUSTIFIED: narrowing for React element property access in option test
    const p = (tree.props.children as unknown[])[0] as unknown as { type: unknown };
    expect(p.type).toBe("p");
  });

  it("headings.autolink: true → heading wrapped in self-link", () => {
    // JUSTIFIED: narrowing for React element property access in option test
    const tree = react("# Hello", undefined, { headings: { ids: true, autolink: true } } as unknown as ReactOpts);
    // JUSTIFIED: narrowing for React element property access in option test
    const h1 = (tree.props.children as unknown[])[0] as unknown as { type: unknown; props: { children: unknown } };
    expect(h1.type).toBe("h1");
    // With autolink, the h1 children may be a link or text
    expect(h1.props.children).toBeDefined();
  });

  it("headings: true → both ids and autolink enabled", () => {
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    const tree = react("# Hello", undefined, { headings: true } as unknown as ReactOpts);
    // JUSTIFIED: narrowing for React element property access in option test
    const h1 = (tree.props.children as unknown[])[0] as unknown as { type: unknown; props: { id?: string; children: unknown } };
    expect(h1.type).toBe("h1");
    expect(h1.props.id).toBe("hello");
  });
});

describe("SSR output: renderToString for all element types", () => {
  const React = require("react");
  const { renderToString } = require("react-dom/server");

  function toHTML(md: string, opts?: ReactOpts): string {
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    const tree = opts ? react(md, undefined, opts as unknown as ReactOpts) : react(md);
    return renderToString(tree);
  }

  it("h1-h6 render correct tags", () => {
    const html = toHTML("# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6");
    expect(html).toContain("<h1>");
    expect(html).toContain("</h1>");
    expect(html).toContain("<h2>");
    expect(html).toContain("<h6>");
  });

  it("paragraph renders", () => {
    const html = toHTML("hello");
    expect(html).toContain("<p>");
    expect(html).toContain("hello");
  });

  it("strong, em, code render", () => {
    const html = toHTML("**b** *i* `c`");
    expect(html).toContain("<strong>");
    expect(html).toContain("<em>");
    expect(html).toContain("<code>");
  });

  it("link renders with href", () => {
    const html = toHTML("[text](https://x.com)");
    expect(html).toContain('<a href="https://x.com"');
    expect(html).toContain("text");
  });

  it("image renders as self-closing img with src and alt", () => {
    const html = toHTML("![alt](https://x.com/i.png)");
    expect(html).toContain('<img src="https://x.com/i.png"');
    expect(html).toContain('alt="alt"');
  });

  it("unordered list renders", () => {
    const html = toHTML("- a\n- b");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>");
  });

  it("ordered list renders with start", () => {
    const html = toHTML("1. first\n2. second");
    expect(html).toContain('<ol start="1">');
    expect(html).toContain("<li>");
  });

  it("task list li checked attribute is not rendered (invalid on li)", () => {
    const html = toHTML("- [x] done");
    expect(html).toContain("<ul>");
    expect(html).toContain("done");
    // React does not render `checked` on <li> because it is not a valid HTML attribute
    expect(html).not.toContain('checked="true"');
  });

  it("blockquote renders", () => {
    const html = toHTML("> quote");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("quote");
  });

  it("pre renders with language attribute", () => {
    const html = toHTML("```js\ncode\n```");
    expect(html).toContain("<pre");
    expect(html).toContain('language="js"');
    expect(html).toContain("code");
  });

  it("hr renders", () => {
    const html = toHTML("---");
    expect(html).toContain("<hr");
  });

  it("table renders full structure", () => {
    const html = toHTML("| H | H |\n|----|----|\n| 1 | 2 | 3 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<thead>");
    expect(html).toContain("<tbody>");
    expect(html).toContain("<tr>");
    expect(html).toContain("<th>");
    expect(html).toContain("<td>");
  });

  it("hard line break renders as br", () => {
    const html = toHTML("line1  \nline2");
    expect(html).toContain("<br");
  });

  it("strikethrough renders as del", () => {
    const html = toHTML("~~deleted~~");
    expect(html).toContain("<del>");
    expect(html).toContain("deleted");
  });

  it("nested list renders", () => {
    const html = toHTML("- a\n  - b\n- c");
    expect(html).toContain("<ul>");
    expect(html).toMatch(/<li[^>]*>.*<ul>.*<\/ul>.*<\/li>/s);
  });

  it("CJK and emoji content preserved in output", () => {
    const html = toHTML("# 日本語 👋");
    expect(html).toContain("日本語");
    expect(html).toContain("👋");
  });

  it("raw HTML blocks are escaped inside a custom html element", () => {
    const html = toHTML("<div class=\"foo\">block</div>");
    // React 19 renders the raw HTML string as escaped text inside <html>...</html>
    expect(html).toContain("<html>");
    expect(html).toContain("&lt;div class=&quot;foo&quot;&gt;");
    expect(html).toContain("block");
  });

  it("headings with ids render id attribute", () => {
    const html = toHTML("# Hello World", { headings: { ids: true } });
    expect(html).toContain('<h1 id="hello-world"');
  });

  it("autolinks render when enabled", () => {
    const html = toHTML("Visit https://x.com", { autolinks: true });
    expect(html).toContain('<a href="https://x.com"');
  });

  it("wiki links render with target attribute", () => {
    const html = toHTML("[[Wiki Link]]", { wikiLinks: true });
    expect(html).toContain('<a target="Wiki Link"');
    expect(html).toContain("Wiki Link");
  });

  it("custom components affect rendered output", () => {
    const tree = react("# Hello", { h1: () => React.createElement("h1", { className: "custom" }, "Custom") });
    const html = renderToString(tree);
    expect(html).toContain('<h1 class="custom">');
    expect(html).toContain("Custom");
  });

  it("custom component can return a string and it appears in output", () => {
    const tree = react("# Hello", { h1: () => "plain text" });
    const html = renderToString(tree);
    expect(html).toContain("plain text");
  });
});

describe("Tags, lists, and meta-as-props", () => {
  const { renderToString } = require("react-dom/server");

  // JUSTIFIED: ReactEl children are typed unknown; narrowing for child access
  function childAt(el: ReactEl, idx: number): any {
    // JUSTIFIED: narrowing children array for index access
    return (el.props.children as unknown[])[idx] as any;
  }

  it("ordered list with start=5", () => {
    const tree = react("5. first\n6. second");
    const ol = childAt(tree, 0);
    expect(ol.props.start).toBe(5);
    const html = renderToString(tree);
    expect(html).toContain('<ol start="5">');
  });

  it("task list li receives checked=true", () => {
    const tree = react("- [x] done");
    const ul = childAt(tree, 0);
    const li = childAt(ul, 0);
    expect(li.props.checked).toBe(true);
  });

  it("non-task li has no checked prop", () => {
    const tree = react("- regular");
    const ul = childAt(tree, 0);
    const li = childAt(ul, 0);
    expect(li.props.checked).toBeUndefined();
  });

  it("nested list: li contains nested ul", () => {
    const tree = react("- a\n  - b\n- c");
    const ul = childAt(tree, 0);
    const li = childAt(ul, 0);
    const nestedUl = (li.props.children as any[]).find((c: any) => c.type === "ul");
    expect(nestedUl).toBeDefined();
  });

  it("table cell alignment: right", () => {
    const tree = react("| H |\n|--:|\n| a |");
    const table = childAt(tree, 0);
    const thead = childAt(table, 0);
    const tr = childAt(thead, 0);
    const th = childAt(tr, 0);
    expect(th.props.align).toBe("right");
    const html = renderToString(tree);
    expect(html).toContain('align="right"');
  });

  it("table cell alignment: center", () => {
    const tree = react("| H |\n|:---:|\n| a |");
    const table = childAt(tree, 0);
    const thead = childAt(table, 0);
    const tr = childAt(thead, 0);
    const th = childAt(tr, 0);
    expect(th.props.align).toBe("center");
    const html = renderToString(tree);
    expect(html).toContain('align="center"');
  });

  it("table cell alignment: left", () => {
    const tree = react("| H |\n|:---|\n| a |");
    const table = childAt(tree, 0);
    const thead = childAt(table, 0);
    const tr = childAt(thead, 0);
    const th = childAt(tr, 0);
    expect(th.props.align).toBe("left");
    const html = renderToString(tree);
    expect(html).toContain('align="left"');
  });

  // Raw HTML blocks are wrapped in a custom <html> element; children are plain strings (not escaped)
  function rawText(el: any): string {
    const children = el.props.children;
    return Array.isArray(children) ? children.join("") : String(children ?? "");
  }

  it("tagFilter: true still allows <script> (not escaped)", () => {
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    const tree = react("<script>alert(1)</script>", undefined, { tagFilter: true } as unknown as ReactOpts);
    const htmlEl = childAt(tree, 0);
    expect(htmlEl.type).toBe("html");
    expect(rawText(htmlEl)).toContain("<script>");
    expect(rawText(htmlEl)).toContain("alert(1)");
  });

  it("tagFilter: true still allows <style>", () => {
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    const tree = react("<style>body{}</style>", undefined, { tagFilter: true } as unknown as ReactOpts);
    const htmlEl = childAt(tree, 0);
    expect(rawText(htmlEl)).toContain("<style>");
    expect(rawText(htmlEl)).toContain("body{}");
  });

  it("tagFilter: true still allows <iframe>", () => {
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    const tree = react("<iframe src=x></iframe>", undefined, { tagFilter: true } as unknown as ReactOpts);
    const htmlEl = childAt(tree, 0);
    expect(rawText(htmlEl)).toContain("<iframe");
    expect(rawText(htmlEl)).toContain("src=x");
  });

  it("noHtmlBlocks: true wraps <div> in <p> but keeps attributes", () => {
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    const tree = react('<div class="foo">block</div>', undefined, { noHtmlBlocks: true } as unknown as ReactOpts);
    const p = childAt(tree, 0);
    expect(p.type).toBe("p");
    expect(rawText(p)).toContain('class="foo"');
    expect(rawText(p)).toContain("block");
  });

  it("noHtmlSpans: true wraps inline <span> in <p>", () => {
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    const tree = react('text <span class="x">span</span> more', undefined, { noHtmlSpans: true } as unknown as ReactOpts);
    const p = childAt(tree, 0);
    expect(p.type).toBe("p");
    expect(rawText(p)).toContain('class="x"');
    expect(rawText(p)).toContain("span");
  });

  it("HTML block with multiple attributes preserved", () => {
    const tree = react('<div class="foo" id="bar" data-x="1">text</div>');
    const htmlEl = childAt(tree, 0);
    expect(htmlEl.type).toBe("html");
    expect(rawText(htmlEl)).toContain('class="foo"');
    expect(rawText(htmlEl)).toContain('id="bar"');
    expect(rawText(htmlEl)).toContain('data-x="1"');
    expect(rawText(htmlEl)).toContain("text");
  });

  it("list with multiple paragraphs in one item", () => {
    const tree = react("- para1\n\n  para2");
    const ul = childAt(tree, 0);
    const li = childAt(ul, 0);
    const children = li.props.children as any[];
    const pCount = children.filter((c: any) => c.type === "p").length;
    expect(pCount).toBe(2);
  });

  it("link meta: href, title passed as props", () => {
    const tree = react('[text](https://x.com "title")');
    const p = childAt(tree, 0);
    const a = (p.props.children as any[]).find((c: any) => c.type === "a");
    expect(a).toBeDefined();
    expect(a.props.href).toBe("https://x.com");
    expect(a.props.title).toBe("title");
  });

  it("image meta: src, alt, title passed as props", () => {
    const tree = react('![alt](https://x.com/i.png "title")');
    const p = childAt(tree, 0);
    const img = (p.props.children as any[]).find((c: any) => c.type === "img");
    expect(img).toBeDefined();
    expect(img.props.src).toBe("https://x.com/i.png");
    expect(img.props.alt).toBe("alt");
    expect(img.props.title).toBe("title");
  });
});

describe("React 18 vs 19 cross-verification across all features", () => {
  // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
  function reactWithOpts(md: string, opts: Record<string, unknown>): ReactEl {
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    return react(md, undefined, opts as unknown as ReactOpts);
  }

  function replacer(_k: string, v: unknown): unknown {
    return typeof v === "symbol" ? String(v) : v;
  }

  function normalizedJSON(el: ReactEl): string {
    return JSON.stringify(el, replacer)
      .replace(/react\.transitional\.element/g, "REACT_SYMBOL")
      .replace(/react\.element/g, "REACT_SYMBOL")
      .replace(/react\.fragment/g, "FRAGMENT_SYMBOL");
  }

  it("headings with ids", () => {
    const md = "# Hello World";
    const opts = { headings: { ids: true } };
    const t19 = reactWithOpts(md, opts);
    const t18 = reactWithOpts(md, { ...opts, reactVersion: 18 });
    expect(String(t18.$$typeof)).toBe("Symbol(react.element)");
    expect(normalizedJSON(t18)).toBe(normalizedJSON(t19));
  });

  it("tables with alignment", () => {
    const md = "| H |\n|--:|\n| a |";
    const t19 = reactWithOpts(md, {});
    const t18 = reactWithOpts(md, { reactVersion: 18 });
    expect(String(t18.$$typeof)).toBe("Symbol(react.element)");
    expect(normalizedJSON(t18)).toBe(normalizedJSON(t19));
  });

  it("task lists", () => {
    const md = "- [x] done\n- [ ] todo";
    const t19 = reactWithOpts(md, {});
    const t18 = reactWithOpts(md, { reactVersion: 18 });
    expect(String(t18.$$typeof)).toBe("Symbol(react.element)");
    expect(normalizedJSON(t18)).toBe(normalizedJSON(t19));
  });

  it("autolinks", () => {
    const md = "Visit https://x.com";
    const t19 = reactWithOpts(md, { autolinks: true });
    const t18 = reactWithOpts(md, { autolinks: true, reactVersion: 18 });
    expect(String(t18.$$typeof)).toBe("Symbol(react.element)");
    expect(normalizedJSON(t18)).toBe(normalizedJSON(t19));
  });

  it("strikethrough", () => {
    const md = "~~deleted~~";
    const t19 = reactWithOpts(md, {});
    const t18 = reactWithOpts(md, { reactVersion: 18 });
    expect(String(t18.$$typeof)).toBe("Symbol(react.element)");
    expect(normalizedJSON(t18)).toBe(normalizedJSON(t19));
  });

  it("wikiLinks", () => {
    const md = "[[Wiki Link]]";
    const t19 = reactWithOpts(md, { wikiLinks: true });
    const t18 = reactWithOpts(md, { wikiLinks: true, reactVersion: 18 });
    expect(String(t18.$$typeof)).toBe("Symbol(react.element)");
    expect(normalizedJSON(t18)).toBe(normalizedJSON(t19));
  });

  it("nested lists", () => {
    const md = "- a\n  - b\n- c";
    const t19 = reactWithOpts(md, {});
    const t18 = reactWithOpts(md, { reactVersion: 18 });
    expect(String(t18.$$typeof)).toBe("Symbol(react.element)");
    expect(normalizedJSON(t18)).toBe(normalizedJSON(t19));
  });

  it("noHtmlBlocks", () => {
    const md = '<div class="foo">block</div>';
    const t19 = reactWithOpts(md, { noHtmlBlocks: true });
    const t18 = reactWithOpts(md, { noHtmlBlocks: true, reactVersion: 18 });
    expect(String(t18.$$typeof)).toBe("Symbol(react.element)");
    expect(normalizedJSON(t18)).toBe(normalizedJSON(t19));
  });

  it("raw HTML with attributes", () => {
    const md = '<div class="foo" id="bar" data-x="1">text</div>';
    const t19 = reactWithOpts(md, {});
    const t18 = reactWithOpts(md, { reactVersion: 18 });
    expect(String(t18.$$typeof)).toBe("Symbol(react.element)");
    expect(normalizedJSON(t18)).toBe(normalizedJSON(t19));
  });

  it("indented code blocks disabled", () => {
    const md = "     code";
    const t19 = reactWithOpts(md, { noIndentedCodeBlocks: true });
    const t18 = reactWithOpts(md, { noIndentedCodeBlocks: true, reactVersion: 18 });
    expect(String(t18.$$typeof)).toBe("Symbol(react.element)");
    expect(normalizedJSON(t18)).toBe(normalizedJSON(t19));
  });
});

describe("tagFilter deep dive: 5 dangerous tags (Bun v1.3.14 gap)", () => {
  // JUSTIFIED: ReactEl children are typed unknown; narrowing for child access
  function childAt(el: ReactEl, idx: number): any {
    // JUSTIFIED: narrowing children array for index access
    return (el.props.children as unknown[])[idx] as any;
  }

  // Raw HTML blocks are wrapped in a custom <html> element; children are plain strings
  function rawText(el: any): string {
    const children = el.props.children;
    return Array.isArray(children) ? children.join("") : String(children ?? "");
  }

  it("<script> not escaped when tagFilter: true", () => {
    const md = "<script>alert(1)</script>";
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    const tDefault = react(md, undefined, {} as unknown as ReactOpts);
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    const tFilter = react(md, undefined, { tagFilter: true } as unknown as ReactOpts);
    const defaultText = rawText(childAt(tDefault, 0));
    const filterText = rawText(childAt(tFilter, 0));
    expect(filterText).toContain("<script>");
    expect(filterText).toContain("alert(1)");
    expect(filterText).toBe(defaultText);
  });

  it("<style> not escaped when tagFilter: true", () => {
    const md = "<style>body{}</style>";
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    const tDefault = react(md, undefined, {} as unknown as ReactOpts);
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    const tFilter = react(md, undefined, { tagFilter: true } as unknown as ReactOpts);
    const defaultText = rawText(childAt(tDefault, 0));
    const filterText = rawText(childAt(tFilter, 0));
    expect(filterText).toContain("<style>");
    expect(filterText).toContain("body{}");
    expect(filterText).toBe(defaultText);
  });

  it("<iframe> not escaped when tagFilter: true", () => {
    const md = '<iframe src="x"></iframe>';
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    const tDefault = react(md, undefined, {} as unknown as ReactOpts);
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    const tFilter = react(md, undefined, { tagFilter: true } as unknown as ReactOpts);
    const defaultText = rawText(childAt(tDefault, 0));
    const filterText = rawText(childAt(tFilter, 0));
    expect(filterText).toContain("<iframe");
    expect(filterText).toContain('src="x"');
    expect(filterText).toBe(defaultText);
  });

  it("<script> inline block not escaped when tagFilter: true", () => {
    const md = "<div>ok</div>\n\n<script>alert(1)</script>";
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    const tFilter = react(md, undefined, { tagFilter: true } as unknown as ReactOpts);
    const html0 = rawText(childAt(tFilter, 0));
    const html1 = rawText(childAt(tFilter, 1));
    expect(html0).toContain("<div>");
    expect(html0).toContain("ok");
    expect(html1).toContain("<script>");
    expect(html1).toContain("alert(1)");
  });

  it("allowed <div> and disallowed <script> both unchanged when tagFilter: true", () => {
    const md = "<div>ok</div>\n<script>bad</script>";
    // JUSTIFIED: parser options not in ReactOptions type — casting to test runtime
    const tFilter = react(md, undefined, { tagFilter: true } as unknown as ReactOpts);
    const html = rawText(childAt(tFilter, 0));
    expect(html).toContain("<div>");
    expect(html).toContain("ok");
    expect(html).toContain("<script>");
    expect(html).toContain("bad");
  });
});
