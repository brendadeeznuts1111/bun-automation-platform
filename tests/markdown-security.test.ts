/**
 * Bun.markdown.html() security audit — XSS vectors and mitigations.
 *
 * Verifies that Bun.markdown.html() passes through raw HTML (including
 * <script> tags) by default, and that the documented mitigation options
 * (tagFilter, noHtmlBlocks, noHtmlSpans) only partially help.
 *
 * Ref: https://bun.com/docs/runtime/markdown
 * Ref: https://bun.com/docs/runtime/utils (Bun.escapeHTML for sanitization)
 *
 * For untrusted input, use Bun.escapeHTML() or a sanitization library
 * like DOMPurify on the rendered HTML output.
 */

import { describe, expect, it } from "bun:test";

// Detect dangerous patterns in rendered HTML output.
// Uses attribute-scoped regexes to avoid false positives on legitimate
// URLs like https://javascript.com (which contains "javascript:" as a
// substring but is not the javascript: protocol).
// Matches both quoted (href="javascript:") and unquoted (href=javascript:) attrs.
function isDangerous(html: string): boolean {
  return (
    /<script/i.test(html) ||
    /onerror\s*=/i.test(html) ||
    /onload\s*=/i.test(html) ||
    /href=["']?javascript:/i.test(html) ||
    /src=["']?javascript:/i.test(html) ||
    /href=["']?vbscript:/i.test(html) ||
    /href=["']?data:text\/html/i.test(html) ||
    /src=["']?data:text\/html/i.test(html) ||
    /<iframe/i.test(html) ||
    /<object\b/i.test(html) ||
    /<embed\b/i.test(html) ||
    /<base\b/i.test(html) ||
    /<form\b/i.test(html) ||
    /<link\b/i.test(html)
  );
}

describe("Bun.markdown.html() XSS audit", () => {
  describe("dangerous vectors (pass through by default)", () => {
    const dangerousVectors: Record<string, string> = {
      "script tag": "<script>alert(1)</script>",
      "img onerror": "<img src=x onerror=alert(1)>",
      "svg onload": "<svg onload=alert(1)>",
      iframe: "<iframe src=javascript:alert(1)>",
      "javascript URL": "[click](javascript:alert(1))",
      "data URL": "[click](data:text/html,<script>alert(1)</script>)",
      "vbscript URL": "[click](vbscript:msgbox(1))",
      "img javascript": "![x](javascript:alert(1))",
      "img data URL": "![x](data:text/html,<script>alert(1)</script>)",
      CDATA: "<![CDATA[<script>alert(1)</script>]]>",
      "link tag": "<link rel=stylesheet href=javascript:alert(1)>",
      "object tag": "<object data=javascript:alert(1)>",
      "embed tag": "<embed src=javascript:alert(1)>",
      "form tag": "<form action=javascript:alert(1)><button>X</button></form>",
      "base tag": "<base href=javascript:alert(1)//>",
      "math tag": "<math><mtext><script>alert(1)</script></mtext></math>",
      "table injection": "| A | B |\n|---|---|\n| <script>alert(1)</script> | 2 |",
      "heading injection": "# <script>alert(1)</script>",
      "blockquote injection": "> <script>alert(1)</script>",
      "list injection": "- <script>alert(1)</script>",
      "img alt XSS": "![<script>alert(1)</script>](url)",
      "autolink XSS": "https://example.com/<script>alert(1)</script>",
      "nested script": "<scr<script>ipt>alert(1)</script>",
      "uppercase script": "<SCRIPT>alert(1)</SCRIPT>",
      "mixed case script": "<ScRiPt>alert(1)</ScRiPt>",
    };

    for (const [name, md] of Object.entries(dangerousVectors)) {
      it(`⚠️  "${name}" passes through dangerous HTML`, () => {
        const html = Bun.markdown.html(md, { autolinks: true });
        // These vectors are KNOWN to be dangerous — we assert they ARE
        // dangerous so the test fails if Bun ever fixes the XSS (at which
        // point we'd update the test to expect safety).
        expect(isDangerous(html)).toBe(true);
      });
    }
  });

  describe("safe vectors (correctly handled)", () => {
    const safeVectors: Record<string, string> = {
      "html comment": "<!-- comment -->",
      "style tag": "<style>body{background:red}</style>",
      "code injection": "```ts\n</code><script>alert(1)</script>\n```",
      "encoded script": "&#60;script&#62;alert(1)&#60;/script&#62;",
      "unicode escape": "\\u003cscript\\u003ealert(1)\\u003c/script\\u003e",
      "null byte script": "<scri\x00pt>alert(1)</scri\x00pt>",
      "script with null": "<script\x00>alert(1)</script>",
    };

    for (const [name, md] of Object.entries(safeVectors)) {
      it(`✅ "${name}" is safe`, () => {
        const html = Bun.markdown.html(md, { autolinks: true });
        expect(isDangerous(html)).toBe(false);
      });
    }
  });

  describe("mitigation options", () => {
    const mitigationVectors: Record<string, string> = {
      "script tag": "<script>alert(1)</script>",
      "img onerror": "<img src=x onerror=alert(1)>",
      "javascript URL": "[click](javascript:alert(1))",
      iframe: "<iframe src=javascript:alert(1)>",
      "heading injection": "# <script>alert(1)</script>",
    };

    it("default (no options) — all 5 vectors dangerous", () => {
      let dangerous = 0;
      for (const md of Object.values(mitigationVectors)) {
        if (isDangerous(Bun.markdown.html(md, { autolinks: true }))) dangerous++;
      }
      expect(dangerous).toBe(5);
    });

    it("tagFilter — partially blocks (script + iframe)", () => {
      let dangerous = 0;
      for (const md of Object.values(mitigationVectors)) {
        if (isDangerous(Bun.markdown.html(md, { autolinks: true, tagFilter: true }))) dangerous++;
      }
      // tagFilter escapes <script> and <iframe> opening tags but not
      // javascript: URLs, onerror, or heading injection
      expect(dangerous).toBeLessThan(5);
      expect(dangerous).toBeGreaterThan(0);
    });

    it("noHtmlBlocks — broken (no effect)", () => {
      let dangerous = 0;
      for (const md of Object.values(mitigationVectors)) {
        if (isDangerous(Bun.markdown.html(md, { autolinks: true, noHtmlBlocks: true }))) dangerous++;
      }
      // noHtmlBlocks is broken — same as default
      expect(dangerous).toBe(5);
    });

    it("noHtmlSpans — blocks heading injection only", () => {
      let dangerous = 0;
      for (const md of Object.values(mitigationVectors)) {
        if (isDangerous(Bun.markdown.html(md, { autolinks: true, noHtmlSpans: true }))) dangerous++;
      }
      // noHtmlSpans escapes inline HTML in headings/paragraphs
      expect(dangerous).toBeLessThan(5);
    });

    it("all three combined — best available mitigation", () => {
      let dangerous = 0;
      for (const md of Object.values(mitigationVectors)) {
        if (
          isDangerous(
            Bun.markdown.html(md, {
              autolinks: true,
              tagFilter: true,
              noHtmlBlocks: true,
              noHtmlSpans: true,
            }),
          )
        )
          dangerous++;
      }
      // Even with all three, javascript: URLs still pass through
      expect(dangerous).toBeGreaterThan(0);
    });

    it("Bun.escapeHTML escapes angle brackets and quotes (partial sanitization)", () => {
      // Bun.escapeHTML escapes <>&"' but does NOT remove event handler
      // attributes like onerror= or javascript: URLs. It prevents
      // <script> tags from rendering but is NOT a complete XSS sanitizer.
      for (const md of Object.values(mitigationVectors)) {
        const html = Bun.markdown.html(md, { autolinks: true });
        const sanitized = Bun.escapeHTML(html);
        // <script> tags are escaped — no literal <script> remains
        expect(sanitized).not.toMatch(/<script/i);
        // <iframe> tags are escaped
        expect(sanitized).not.toMatch(/<iframe/i);
        // BUT onerror= attributes survive (escapeHTML doesn't remove attrs)
        // and javascript: URLs survive in attribute values
        // This is why escapeHTML alone is NOT sufficient — use DOMPurify
      }
    });
  });

  describe("URL scheme filtering", () => {
    it("javascript: scheme allowed in link href (XSS)", () => {
      const html = Bun.markdown.html("[click](javascript:alert(1))");
      expect(html).toContain("javascript:alert(1)");
    });

    it("javascript: scheme allowed in image src (XSS)", () => {
      const html = Bun.markdown.html("![x](javascript:alert(1))");
      expect(html).toContain("javascript:alert(1)");
    });

    it("data:text/html allowed in link href (XSS)", () => {
      const html = Bun.markdown.html("[click](data:text/html,<script>)");
      expect(html).toContain("data:text/html");
    });

    it("https: scheme works normally", () => {
      const html = Bun.markdown.html("[click](https://example.com)");
      expect(html).toContain('href="https://example.com"');
    });

    it("mailto: scheme works normally", () => {
      const html = Bun.markdown.html("[email](mailto:test@example.com)");
      expect(html).toContain('href="mailto:test@example.com"');
    });
  });
});
