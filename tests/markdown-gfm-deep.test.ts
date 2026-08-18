/**
 * Deep audit: Bun.markdown.html() GFM features and input types.
 *
 * XREF: Bug cross-reference chain — see docs/render-diagrams.ts#cross-reference-chain
 * This file covers Bug 26 (doc:2289), 27 (doc:2290), 28 (doc:2292)
 *
 * Verifies:
 * - Bug 26: Frontmatter (YAML) not stripped — rendered as HR + heading
 * - Bug 27: Math blocks ($$) not supported — rendered as literal text
 * - Bug 28: Heading IDs with non-ASCII (CJK) produce empty id=""
 * - Buffer/Uint8Array input accepted (docs say "string or buffer")
 * - GFM task lists (checkboxes)
 * - Strikethrough (single tilde)
 * - Emoji in markdown
 * - Nested formatting (bold/italic nesting)
 * - Blockquote nesting
 * - Ordered list with start attribute
 * - Large input handling
 * - react() output structure
 *
 * Ref: https://bun.com/docs/runtime/markdown
 */

import { describe, expect, test } from "bun:test";

describe("Bun.markdown.html() GFM features", () => {
  describe("input types", () => {
    test("accepts Uint8Array (buffer input)", () => {
      const buf = new TextEncoder().encode("# Hello");
      // JUSTIFIED: bun-types declares html() input as string, but docs say
      // "string or buffer" and runtime accepts Uint8Array.
      const html = Bun.markdown.html(buf as never);
      expect(html).toContain("<h1");
      expect(html).toContain("Hello");
    });

    test("accepts Buffer", () => {
      const buf = Buffer.from("# Hello");
      // JUSTIFIED: same as above — Buffer is accepted at runtime
      const html = Bun.markdown.html(buf as never);
      expect(html).toContain("<h1");
    });
  });

  describe("GFM task lists", () => {
    test("unchecked task renders checkbox (not checked)", () => {
      const html = Bun.markdown.html("- [ ] todo");
      expect(html).toContain('type="checkbox"');
      expect(html).toContain("disabled");
      expect(html).not.toContain("checked");
    });

    test("checked task renders checkbox with checked attribute", () => {
      const html = Bun.markdown.html("- [x] done");
      expect(html).toContain('type="checkbox"');
      expect(html).toContain("checked");
    });

    test("task list items get task-list-item class", () => {
      const html = Bun.markdown.html("- [ ] todo\n- [x] done");
      expect(html).toContain("task-list-item");
    });
  });

  describe("strikethrough", () => {
    test("single tilde ~~ renders as <del>", () => {
      const html = Bun.markdown.html("~~strike~~");
      expect(html).toContain("<del>strike</del>");
    });

    test("triple tilde ~~~ renders as code block (not strikethrough)", () => {
      const html = Bun.markdown.html("~~~not strike~~~");
      expect(html).toContain("<pre><code");
    });
  });

  describe("emoji support", () => {
    test("emoji in heading", () => {
      const html = Bun.markdown.html("# 🚀 Emoji");
      expect(html).toContain("🚀");
    });

    test("emoji in paragraph", () => {
      const html = Bun.markdown.html("Text with 🔥 emoji");
      expect(html).toContain("🔥");
    });

    test("emoji in list items", () => {
      const html = Bun.markdown.html("- 📝 item\n- ✅ done");
      expect(html).toContain("📝");
      expect(html).toContain("✅");
    });
  });

  describe("nested formatting", () => {
    test("bold containing italic", () => {
      const html = Bun.markdown.html("**bold *italic* bold**");
      expect(html).toContain("<strong>");
      expect(html).toContain("<em>italic</em>");
    });

    test("italic containing bold", () => {
      const html = Bun.markdown.html("*italic **bold** italic*");
      expect(html).toContain("<em>");
      expect(html).toContain("<strong>bold</strong>");
    });

    test("bold link", () => {
      const html = Bun.markdown.html("[**bold link**](https://example.com)");
      expect(html).toContain('href="https://example.com"');
      expect(html).toContain("<strong>bold link</strong>");
    });
  });

  describe("blockquote nesting", () => {
    test("3 levels of nesting", () => {
      const html = Bun.markdown.html("> L1\n> > L2\n> > > L3");
      const blockquotes = html.match(/<blockquote/g) ?? [];
      expect(blockquotes.length).toBe(3);
    });
  });

  describe("ordered list", () => {
    test("start attribute for non-1 start", () => {
      const html = Bun.markdown.html("3. Three\n4. Four\n5. Five");
      expect(html).toContain('start="3"');
    });

    test("default start is 1 (no start attribute)", () => {
      const html = Bun.markdown.html("1. One\n2. Two");
      expect(html).not.toContain("start=");
    });
  });

  describe("nested lists", () => {
    test("3 levels of unordered nesting", () => {
      const html = Bun.markdown.html("- Top\n  - Nested\n    - Deep\n  - Back\n- Top 2");
      const uls = html.match(/<ul/g) ?? [];
      expect(uls.length).toBe(3);
    });

    test("mixed ordered/unordered", () => {
      const html = Bun.markdown.html("1. First\n   - Sub item\n2. Second");
      expect(html).toContain("<ol>");
      expect(html).toContain("<ul>");
    });
  });

  describe("table with formatting in cells", () => {
    test("bold, italic, code, strike, link, image in cells", () => {
      const html = Bun.markdown.html("| **B** | *I* | `c` |\n|---|---|---|\n| ~~s~~ | [l](u) | ![i](x.png) |");
      expect(html).toContain("<strong>B</strong>");
      expect(html).toContain("<em>I</em>");
      expect(html).toContain("<code>c</code>");
      expect(html).toContain("<del>s</del>");
      expect(html).toContain('href="u"');
      expect(html).toContain('src="x.png"');
    });
  });

  describe("Bug 26: frontmatter not stripped", () => {
    test("YAML frontmatter rendered as HR + heading (not stripped)", () => {
      const html = Bun.markdown.html("---\ntitle: Test\n---\n# Body");
      // Bug: frontmatter should be stripped, but Bun renders --- as <hr>
      // and "title: Test" as <h2>
      expect(html).toContain("<hr");
      expect(html).toContain("title: Test");
      expect(html).toContain("<h1>Body</h1>");
    });
  });

  describe("Bug 27: math blocks not supported", () => {
    test("$$ math block rendered as literal paragraph", () => {
      const html = Bun.markdown.html("$$\nx^2 + y^2 = z^2\n$$");
      // Bug: math should render as <div class="math"> but Bun shows literal
      expect(html).toContain("$$");
      expect(html).toContain("x^2");
      expect(html).not.toContain('class="math"');
    });

    test("inline $ math rendered as literal text", () => {
      const html = Bun.markdown.html("Inline $x^2$ math");
      expect(html).toContain("$x^2$");
      expect(html).not.toContain('class="math"');
    });
  });

  describe("Bug 28: heading IDs with CJK produce empty string", () => {
    test("Japanese heading gets empty id", () => {
      const html = Bun.markdown.html("# 日本語", { headings: { ids: true } });
      // Bug: CJK characters produce empty id=""
      expect(html).toContain('id=""');
    });

    test("accented characters produce partial slug", () => {
      const html = Bun.markdown.html("# Café & naïve", { headings: { ids: true } });
      // Accented chars are stripped, & is removed
      expect(html).toContain("id=");
      const idMatch = html.match(/id="([^"]*)"/);
      expect(idMatch?.[1]).not.toContain("é");
    });
  });

  describe("large input", () => {
    test("10000-line input processes correctly", () => {
      const large = Array.from({ length: 10000 }, (_, i) => `Line ${i}`).join("\n");
      const html = Bun.markdown.html(large);
      expect(html.length).toBeGreaterThan(10000);
      expect(html).toContain("Line 0");
      expect(html).toContain("Line 9999");
    });
  });

  describe("react() output", () => {
    test("returns React element with $$typeof symbol", () => {
      const el = Bun.markdown.react("# Hello");
      expect(typeof el).toBe("object");
      // JUSTIFIED: React element type doesn't expose $$typeof in bun-types
      expect(typeof (el as Record<string, unknown>).$$typeof).toBe("symbol");
    });

    test("top-level element is React.Fragment", () => {
      const el = Bun.markdown.react("# Hello\n\nText");
      // JUSTIFIED: React element type doesn't expose `type` in bun-types
      const type = (el as Record<string, unknown>).type;
      expect(typeof type).toBe("symbol"); // Symbol(react.fragment)
    });

    test("props has children key", () => {
      const el = Bun.markdown.react("# Hello");
      // JUSTIFIED: React element type doesn't expose `props` in bun-types
      const props = (el as Record<string, unknown>).props as Record<string, unknown>;
      expect("children" in props).toBe(true);
    });
  });
});
