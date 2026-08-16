/**
 * Deep audit: Bun.markdown.html() options matrix — Bugs 23-25.
 *
 * XREF: Bug cross-reference chain — see docs/render-diagrams.ts#cross-reference-chain
 * This file covers Bug 23 (doc:2196), 24 (doc:2198), 25 (doc:2198)
 *
 * Verifies:
 * - Bug 23: noHtmlBlocks alone doesn't block HTML (only works with noHtmlSpans)
 * - Bug 24: headings.prefix option silently ignored
 * - Bug 25: headings.slugify option silently ignored
 * - Complete options matrix: every option + combination
 * - react() output structure
 * - Input validation (null, undefined, number, object)
 *
 * Ref: https://bun.com/docs/runtime/markdown
 */

import { describe, expect, it } from "bun:test";

const md = `# Heading

Para with **bold**.

<div class="raw">raw html</div>

<details><summary>S</summary></details>

https://autolink.com
`;

describe("Bun.markdown.html() options matrix", () => {
  describe("autolinks", () => {
    it("autolinks: true — bare URLs become links", () => {
      const html = Bun.markdown.html("https://example.com", { autolinks: true });
      expect(html).toContain('href="https://example.com"');
    });

    it("autolinks: false — bare URLs stay as text", () => {
      const html = Bun.markdown.html("https://example.com", { autolinks: false });
      expect(html).not.toContain('href="https://example.com"');
    });

    it("default (no options) — bare URLs NOT autolinked", () => {
      const html = Bun.markdown.html("https://example.com");
      expect(html).not.toContain('href="https://example.com"');
    });
  });

  describe("headings.ids", () => {
    it("ids: true — headings get id attribute", () => {
      const html = Bun.markdown.html("# Hello World", { headings: { ids: true } });
      expect(html).toContain('id="hello-world"');
    });

    it("ids: false — no id attribute", () => {
      const html = Bun.markdown.html("# Hello", { headings: { ids: false } });
      expect(html).not.toContain("id=");
    });

    it("default — no id attribute", () => {
      const html = Bun.markdown.html("# Hello");
      expect(html).not.toContain("id=");
    });

    it("id is slugified from heading text", () => {
      const html = Bun.markdown.html("# Hello World Foo", { headings: { ids: true } });
      expect(html).toContain('id="hello-world-foo"');
    });
  });

  describe("Bug 24: headings.prefix silently ignored", () => {
    // JUSTIFIED: bun-types doesn't declare `prefix` in headings options,
    // but it's accepted at runtime (and silently ignored — Bug 24).
    // Ref: https://bun.com/docs/runtime/markdown
    it("prefix option is ignored (id has no prefix)", () => {
      // JUSTIFIED: bun-types doesn't declare `prefix` in headings options
      const opts = { headings: { ids: true, prefix: "test-" } } as Record<string, unknown>;
      const html = Bun.markdown.html("# Hello", opts);
      // Bug: Expected id="test-hello" but got id="hello"
      expect(html).toContain('id="hello"');
      expect(html).not.toContain('id="test-hello"');
    });
  });

  describe("Bug 25: headings.slugify silently ignored", () => {
    // JUSTIFIED: bun-types doesn't declare `slugify` in headings options,
    // but it's accepted at runtime (and silently ignored — Bug 25).
    it("custom slugify function is ignored (default slugify used)", () => {
      const opts = {
        headings: {
          ids: true,
          slugify: (s: string) => "CUSTOM-" + s.toUpperCase(),
        },
        // JUSTIFIED: bun-types doesn't declare `slugify` in headings options
      } as Record<string, unknown>;
      const html = Bun.markdown.html("# Hello World", opts);
      // Bug: Expected id="CUSTOM-HELLO WORLD" but got id="hello-world"
      expect(html).toContain('id="hello-world"');
      expect(html).not.toContain("CUSTOM");
    });
  });

  describe("noHtmlBlocks", () => {
    it("Bug 23: noHtmlBlocks alone does NOT block HTML blocks", () => {
      const html = Bun.markdown.html("<div>raw</div>", { noHtmlBlocks: true });
      // Bug: noHtmlBlocks alone doesn't work — <div> still passes through
      expect(html).toContain("<div>");
    });

    it("noHtmlBlocks + noHtmlSpans DOES block HTML", () => {
      const html = Bun.markdown.html("<div>raw</div>", {
        noHtmlBlocks: true,
        noHtmlSpans: true,
      });
      expect(html).not.toContain("<div>");
      expect(html).toContain("&lt;div");
    });

    it("noHtmlBlocks: false — HTML passes through", () => {
      const html = Bun.markdown.html("<div>raw</div>", { noHtmlBlocks: false });
      expect(html).toContain("<div>");
    });
  });

  describe("noHtmlSpans", () => {
    it("noHtmlSpans: true — inline HTML escaped", () => {
      const html = Bun.markdown.html("Text <span>inline</span>", { noHtmlSpans: true });
      expect(html).not.toContain("<span>");
      expect(html).toContain("&lt;span");
    });

    it("noHtmlSpans: false — inline HTML passes through", () => {
      const html = Bun.markdown.html("Text <span>inline</span>", { noHtmlSpans: false });
      expect(html).toContain("<span>");
    });
  });

  describe("tagFilter", () => {
    it("tagFilter: true — script tags escaped", () => {
      const html = Bun.markdown.html("<script>alert(1)</script>", { tagFilter: true });
      expect(html).not.toMatch(/<script/i);
    });

    it("tagFilter: true — div tags NOT escaped", () => {
      const html = Bun.markdown.html("<div>div</div>", { tagFilter: true });
      expect(html).toContain("<div>");
    });

    it("tagFilter: true — span tags NOT escaped", () => {
      const html = Bun.markdown.html("<span>span</span>", { tagFilter: true });
      expect(html).toContain("<span>");
    });

    it("tagFilter: false — script tags pass through", () => {
      const html = Bun.markdown.html("<script>alert(1)</script>", { tagFilter: false });
      expect(html).toContain("<script>");
    });
  });

  describe("all options combined", () => {
    it("all options work together", () => {
      const html = Bun.markdown.html(md, {
        autolinks: true,
        headings: { ids: true },
        noHtmlBlocks: true,
        noHtmlSpans: true,
        tagFilter: true,
      });
      expect(html).toContain('id="heading"');
      expect(html).toContain('href="https://autolink.com"');
      expect(html).not.toContain("<div>");
      expect(html).not.toContain("<details>");
    });
  });

  describe("unknown options silently ignored", () => {
    // JUSTIFIED: Testing runtime behavior with unknown options — the `as never`
    // cast is needed because the types correctly reject unknown properties.
    it("unknown options don't throw", () => {
      // JUSTIFIED: testing runtime with unknown options — types correctly reject
      const opts = { unknownOption: true } as Record<string, unknown>;
      const html = Bun.markdown.html("# Test", opts);
      expect(html).toContain("Test");
    });
  });

  describe("input validation", () => {
    it("empty string returns empty string", () => {
      expect(Bun.markdown.html("")).toBe("");
    });

    it("whitespace-only returns empty string", () => {
      expect(Bun.markdown.html("   \n\n  ")).toBe("");
    });

    it("null throws 'Expected a string or buffer'", () => {
      expect(() => Bun.markdown.html(null as never)).toThrow("Expected a string or buffer");
    });

    it("undefined throws 'Expected a string or buffer'", () => {
      expect(() => Bun.markdown.html(undefined as never)).toThrow("Expected a string or buffer");
    });

    it("number throws 'Expected a string or buffer'", () => {
      expect(() => Bun.markdown.html(42 as never)).toThrow("Expected a string or buffer");
    });

    it("object throws 'Expected a string or buffer'", () => {
      expect(() => Bun.markdown.html({ a: 1 } as never)).toThrow("Expected a string or buffer");
    });
  });

  describe("react() output", () => {
    it("returns a React element (object with $$typeof symbol)", () => {
      const el = Bun.markdown.react("# Hello");
      expect(typeof el).toBe("object");
      expect(el).not.toBeNull();
      // React elements have a $$typeof symbol property
      // JUSTIFIED: React element type doesn't expose $$typeof in bun-types
      expect(typeof (el as Record<string, unknown>).$$typeof).toBe("symbol");
    });

    it("react() with options", () => {
      // JUSTIFIED: bun-types declares react() options as ComponentOverrides
      // which doesn't include `autolinks`, but the runtime accepts it.
      // Ref: https://bun.com/docs/runtime/markdown
      // JUSTIFIED: bun-types declares react() options as ComponentOverrides
      const opts = { autolinks: true } as Record<string, unknown>;
      const el = Bun.markdown.react("# Hello", opts);
      expect(typeof el).toBe("object");
    });
  });
});
