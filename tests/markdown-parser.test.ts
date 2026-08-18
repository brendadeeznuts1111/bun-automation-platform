/**
 * Bun.markdown.html() parser edge cases.
 *
 * XREF: Bug cross-reference chain — see docs/render-diagrams.ts#cross-reference-chain
 * Related: Bug 12 (nested links), 15 (URLs with spaces), 16 (escaped pipes)
 *
 * Verifies setext headings, reference links, tight/loose lists, code
 * blocks, tables, HR, headings, emphasis, HTML entities, URL encoding,
 * autolinks, line breaks, and escaping.
 *
 * Also documents known parser bugs (single tilde strikethrough, nested
 * list non-1 start, escaped pipes not unescaped) as test.failing() so
 * they surface if Bun ever fixes them.
 *
 * Ref: https://bun.com/docs/runtime/markdown
 */

import { describe, expect, test } from "bun:test";

const opts = { autolinks: true, headings: { ids: true } } as const;

describe("Bun.markdown.html() parser edge cases", () => {
  describe("setext headings", () => {
    test("h1 with = underline", () => {
      const html = Bun.markdown.html("Heading\n=======", opts);
      expect(html).toContain("<h1");
      expect(html).toContain("Heading");
    });

    test("h2 with - underline", () => {
      const html = Bun.markdown.html("Heading\n-------", opts);
      expect(html).toContain("<h2");
      expect(html).toContain("Heading");
    });

    test("multi-line setext heading", () => {
      const html = Bun.markdown.html("This is a\nsetext heading\n=======", opts);
      expect(html).toContain("<h1");
    });
  });

  describe("reference-style links", () => {
    test("full reference link", () => {
      const html = Bun.markdown.html("[text][1]\n\n[1]: https://example.com", opts);
      expect(html).toContain('href="https://example.com"');
      expect(html).toContain("text");
    });

    test("shortcut reference link", () => {
      const html = Bun.markdown.html("[text]\n\n[text]: https://example.com", opts);
      expect(html).toContain('href="https://example.com"');
    });

    test("reference link with title", () => {
      const html = Bun.markdown.html('[text][1]\n\n[1]: https://example.com "Title"', opts);
      expect(html).toContain('title="Title"');
    });

    test("reference image", () => {
      const html = Bun.markdown.html("![alt][1]\n\n[1]: image.png", opts);
      expect(html).toContain('src="image.png"');
      expect(html).toContain('alt="alt"');
    });
  });

  describe("unsupported GFM extensions", () => {
    test("footnotes not supported (literal text)", () => {
      const html = Bun.markdown.html("Text with a footnote[^1].\n\n[^1]: Footnote content", opts);
      expect(html).toContain("[^1]");
    });

    test("definition lists not supported (literal text)", () => {
      const html = Bun.markdown.html("Term\n: Definition", opts);
      expect(html).toContain(": Definition");
    });
  });

  describe("tight vs loose lists", () => {
    test("tight list (no <p> wrapper)", () => {
      const html = Bun.markdown.html("- a\n- b\n- c", opts);
      expect(html).toContain("<li>a</li>");
      expect(html).not.toContain("<li><p>a</p></li>");
    });

    test("loose list (with <p> wrapper)", () => {
      const html = Bun.markdown.html("- a\n\n- b\n\n- c", opts);
      // Bun formats with newlines: <li>\n<p>a</p>\n</li>
      expect(html).toContain("<p>a</p>");
      expect(html).toContain("<p>b</p>");
      expect(html).toContain("<p>c</p>");
    });
  });

  describe("code blocks", () => {
    test("indented code block (4 spaces)", () => {
      const html = Bun.markdown.html("    code here\n    more code", opts);
      expect(html).toContain("<pre><code>");
      expect(html).toContain("code here");
    });

    test("tilde-fenced code block", () => {
      const html = Bun.markdown.html("~~~ts\ncode\n~~~", opts);
      expect(html).toContain('class="language-ts"');
    });

    test("fenced code with no language", () => {
      const html = Bun.markdown.html("```\ncode\n```", opts);
      expect(html).toContain("<pre><code>");
      expect(html).not.toContain("language-");
    });

    test("4-backtick fence contains 3-backtick", () => {
      const html = Bun.markdown.html("````\ncode with ``` inside\n````", opts);
      expect(html).toContain("``` inside");
    });

    test("info string after language is ignored", () => {
      const html = Bun.markdown.html("```ts line-numbers\ncode\n```", opts);
      expect(html).toContain('class="language-ts"');
      expect(html).not.toContain("line-numbers");
    });
  });

  describe("tables", () => {
    test("empty cells", () => {
      const html = Bun.markdown.html("| A | B |\n|---|---|\n|   |   |", opts);
      expect(html).toContain("<table>");
      expect(html).toContain("<td></td>");
    });

    test("escaped pipe in cell", () => {
      const html = Bun.markdown.html("| A | B |\n|---|---|\n| \\| | 2 |", opts);
      expect(html).toContain("<table>");
    });

    test("no separator row = not a table", () => {
      const html = Bun.markdown.html("| A | B |\n| 1 | 2 |", opts);
      expect(html).not.toContain("<table>");
    });

    test("alignment left", () => {
      const html = Bun.markdown.html("| L | C | R |\n|:--|:-:|--:|\n| 1 | 2 | 3 |", opts);
      expect(html).toContain('align="left"');
      expect(html).toContain('align="center"');
      expect(html).toContain('align="right"');
    });
  });

  describe("horizontal rules", () => {
    test.each(["***", "---", "___", "* * *", "----------"])("HR with %s", (hr) => {
      const html = Bun.markdown.html(hr, opts);
      expect(html).toContain("<hr");
    });
  });

  describe("ATX headings", () => {
    test("trailing # stripped", () => {
      const html = Bun.markdown.html("## Heading ##", opts);
      expect(html).toContain("<h2");
      expect(html).toContain("Heading");
    });

    test("7 hashes = not a heading", () => {
      const html = Bun.markdown.html("####### Not a heading", opts);
      expect(html).not.toContain("<h7");
    });

    test("no space after # = not a heading", () => {
      const html = Bun.markdown.html("##Not a heading", opts);
      expect(html).not.toContain("<h2");
    });
  });

  describe("emphasis", () => {
    test("intraword asterisk works", () => {
      const html = Bun.markdown.html("foo*bar*baz", opts);
      expect(html).toContain("<em>bar</em>");
    });

    test("intraword underscore does NOT work", () => {
      const html = Bun.markdown.html("foo_bar_baz", opts);
      expect(html).not.toContain("<em>");
    });

    test("triple tilde = code block, not strikethrough", () => {
      const html = Bun.markdown.html("~~~not strike~~~", opts);
      expect(html).toContain("<pre><code");
    });
  });

  describe("HTML entities", () => {
    test("named entities decoded", () => {
      const html = Bun.markdown.html("&copy; &reg; &trade;", opts);
      expect(html).toContain("©");
      expect(html).toContain("®");
      expect(html).toContain("™");
    });

    test("numeric entities decoded", () => {
      const html = Bun.markdown.html("&#x41; &#65;", opts);
      expect(html).toContain("A");
    });

    test("entities double-escaped in code", () => {
      const html = Bun.markdown.html("`&amp;`", opts);
      expect(html).toContain("&amp;amp;");
    });
  });

  describe("autolinks", () => {
    test("email autolink", () => {
      const html = Bun.markdown.html("<test@example.com>", opts);
      expect(html).toContain('href="mailto:test@example.com"');
    });

    test("URL autolink", () => {
      const html = Bun.markdown.html("<https://example.com>", opts);
      expect(html).toContain('href="https://example.com"');
    });

    test("bare URL autolinked (with autolinks: true)", () => {
      const html = Bun.markdown.html("https://example.com", opts);
      expect(html).toContain('href="https://example.com"');
    });
  });

  describe("line breaks", () => {
    test("backslash hard break", () => {
      const html = Bun.markdown.html("line 1\\\nline 2", opts);
      expect(html).toContain("<br");
    });

    test("double-space hard break", () => {
      const html = Bun.markdown.html("line 1  \nline 2", opts);
      expect(html).toContain("<br");
    });

    test("soft break (no <br>)", () => {
      const html = Bun.markdown.html("line 1\nline 2", opts);
      expect(html).not.toContain("<br");
    });
  });

  describe("escaping", () => {
    test("escaped asterisk = literal", () => {
      const html = Bun.markdown.html("\\*not bold\\*", opts);
      expect(html).toContain("*not bold*");
      expect(html).not.toContain("<em>");
    });

    test("escaped hash = literal", () => {
      const html = Bun.markdown.html("\\# not a heading", opts);
      expect(html).not.toContain("<h1");
    });

    test("escaped bracket = literal", () => {
      const html = Bun.markdown.html("\\[not a link\\](url)", opts);
      expect(html).not.toContain('href="url"');
    });
  });

  describe("known parser bugs", () => {
    // Bug: single tilde ~text~ renders as strikethrough (should be literal)
    test.failing("single tilde should NOT render as strikethrough", () => {
      const html = Bun.markdown.html("~text~", opts);
      expect(html).not.toContain("<del>");
    });

    // Bug: nested ordered list with non-1 start not recognized as nested list
    test.failing("nested ordered list with non-1 start should create nested <ol>", () => {
      const html = Bun.markdown.html("1. Top\n   5. Starts at 5\n   6. Six\n2. Back", opts);
      // Should have TWO <ol> tags (outer + nested) — bug: only one <ol>
      const olCount = (html.match(/<ol/g) ?? []).length;
      expect(olCount).toBe(2);
    });

    // Escaped pipe in text IS unescaped (bug was fixed)
    test("escaped pipe in text is unescaped", () => {
      const html = Bun.markdown.html("text \\| more", opts);
      expect(html).toContain("text | more");
      expect(html).not.toContain("\\|");
    });

    // Bug: links inside links don't work
    test.failing("links inside links should work", () => {
      const html = Bun.markdown.html("[outer [inner](url2) outer](url1)", opts);
      expect(html).toContain('href="url1"');
    });
  });
});
