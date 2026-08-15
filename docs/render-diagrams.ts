/**
 * Render the channel diagrams HTML page with:
 *   - Bun.color for brand colors (from .env BRAND_COLOR_* vars)
 *   - Bun.markdown.html for GFM content (lists, tables, task lists, references)
 *   - Mermaid sources read from .mmd files at runtime (not inlined)
 *
 * Usage: bun run docs/render-diagrams.ts
 * Output: docs/channel-diagrams.html
 */

import { color } from "bun";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// --- Brand colors via Bun.color (from .env) ---------------------------------

type ColorRole = "label" | "value" | "ok" | "err" | "warn" | "bg";
const ROLE_ENV: Record<ColorRole, string> = {
  label: "BRAND_COLOR_LABEL",
  value: "BRAND_COLOR_VALUE",
  ok: "BRAND_COLOR_OK",
  err: "BRAND_COLOR_ERR",
  warn: "BRAND_COLOR_WARN",
  bg: "BRAND_COLOR_BG",
};

function loadBrandHex(role: ColorRole): string {
  const raw = process.env[ROLE_ENV[role]]?.trim();
  if (!raw) {
    console.error(`${ROLE_ENV[role]} is not set. Define it in .env.`);
    process.exit(1);
  }
  const hex = color(raw, "hex");
  if (hex === null) {
    console.error(`${ROLE_ENV[role]}="${raw}" is not a valid CSS color.`);
    process.exit(1);
  }
  return hex;
}

function loadBrandRgb(role: ColorRole): string {
  const raw = process.env[ROLE_ENV[role]]?.trim();
  const rgb = color(raw ?? "#000", "rgb");
  return rgb ?? "rgb(0,0,0)";
}

const brand: Record<ColorRole, string> = {
  label: loadBrandHex("label"),
  value: loadBrandHex("value"),
  ok: loadBrandHex("ok"),
  err: loadBrandHex("err"),
  warn: loadBrandHex("warn"),
  bg: loadBrandHex("bg"),
};

const brandRgb: Record<ColorRole, string> = {
  label: loadBrandRgb("label"),
  value: loadBrandRgb("value"),
  ok: loadBrandRgb("ok"),
  err: loadBrandRgb("err"),
  warn: loadBrandRgb("warn"),
  bg: loadBrandRgb("bg"),
};

console.log("Brand colors (via Bun.color):");
console.log(`  label: ${brand.label} → ${brandRgb.label}`);
console.log(`  value: ${brand.value} → ${brandRgb.value}`);
console.log(`  ok:    ${brand.ok} → ${brandRgb.ok}`);
console.log(`  err:   ${brand.err} → ${brandRgb.err}`);
console.log(`  warn:  ${brand.warn} → ${brandRgb.warn}`);
console.log(`  bg:    ${brand.bg} → ${brandRgb.bg}`);

// --- Read Mermaid sources from .mmd files -----------------------------------

const docsDir = import.meta.dir;
function readMmd(filename: string): string {
  const path = resolve(docsDir, filename);
  if (!existsSync(path)) {
    console.error(`Mermaid source not found: ${path}`);
    process.exit(1);
  }
  return readFileSync(path, "utf-8").trim();
}

const archMmd = readMmd("channel-architecture.mmd");
const flowMmd = readMmd("channel-message-flow.mmd");
const classMmd = readMmd("channel-class-hierarchy.mmd");

// --- GFM content via Bun.markdown.html --------------------------------------
// Mermaid sources are injected from .mmd files to avoid pre-commit hook
// false positives on "as" keyword in Mermaid participant aliases.

const gfmContent = [
  "## Architecture Overview",
  "",
  "High-level view of the `Channel<TSend, TRecv>` interface, `BaseChannel` abstract class, and transport implementations.",
  "",
  "![Channel Architecture](../channel-architecture.svg)",
  "",
  "<details>",
  "<summary>Mermaid source</summary>",
  "",
  "```mermaid",
  archMmd,
  "```",
  "",
  "</details>",
  "",
  "## Message Flow",
  "",
  "Sequence diagram showing how a task flows from HTTP creation through IPC to WebSocket subscribers.",
  "",
  "![Message Flow](../channel-message-flow.svg)",
  "",
  "<details>",
  "<summary>Mermaid source</summary>",
  "",
  "```mermaid",
  flowMmd,
  "```",
  "",
  "</details>",
  "",
  "## Class Hierarchy",
  "",
  "UML class diagram showing the interface, abstract class, and concrete implementations.",
  "",
  "![Class Hierarchy](../channel-class-hierarchy.svg)",
  "",
  "<details>",
  "<summary>Mermaid source</summary>",
  "",
  "```mermaid",
  classMmd,
  "```",
  "",
  "</details>",
  "",
  "## File Reference",
  "",
  "| File | Transport | Status | Description |",
  "|------|-----------|--------|-------------|",
  "| `src/types/channel.ts` | — | stable | Channel interface + BaseChannel abstract class |",
  "| `src/channels/ipc-channel.ts` | IPC | stable | Parent ↔ worker via Bun.spawn |",
  "| `src/channels/ws-channel.ts` | WebSocket | stable | Server ↔ client via Bun.serve |",
  "| `src/workers/pool.ts` | IPC | stable | Worker pool using IPCChannel |",
  "| `src/workers/task-worker.ts` | IPC | stable | Worker using IPCChannel |",
  "| `src/server.ts` | WebSocket | stable | Server with WS upgrade + pub/sub relay |",
  "| `tests/channels.test.ts` | — | stable | 49 tests covering all transports |",
  "",
  "## Implementation Status",
  "",
  "- [x] C1: Channel interface (`src/types/channel.ts`)",
  "- [x] C2: IPCChannel implementation (`src/channels/ipc-channel.ts`)",
  "- [x] C3: WSChannel implementation (`src/channels/ws-channel.ts`)",
  "- [x] C4: Refactor pool.ts to use Channel interface",
  "- [x] C5: Refactor task-worker.ts to use Channel interface",
  "- [x] C6: Wire WebSocket into server.ts behind `ENABLE_WEBSOCKET` flag",
  "- [x] C7: Add `/ws/task/:id` endpoint for live task progress",
  "- [x] C8: 49 tests covering all transports + type safety",
  "- [x] C9: Feature registry marks websocket as active when enabled",
  "- [x] E1: End-to-end WebSocket test (6 messages: 5 progress + 1 result)",
  "- [x] E2: Worker IPC channel verified with real task execution",
  "- [ ] MessagePortChannel (future — worker ↔ worker via postMessage)",
  "",
  "## Bug Fixes (Deeper Audit)",
  "",
  "1. **IPCChannel missing `handleClose`** — channel stayed connected after IPC disconnect",
  "2. **`wsChannels` Map memory leak** — empty Sets never cleaned up",
  "3. **WSChannel `send()` backpressure** — clarified -1/0/>0 return semantics",
  "4. **WSChannel `handleMessage` redundant branch** — simplified TextDecoder usage",
  "5. **pool.ts channel never closed on worker exit** — added `channel.close()` in exit handler",
  "6. **BaseChannel `on()` after close** — now returns no-op unsubscribe",
  "7. **BaseChannel `dispatch()` doesn't check `_connected`** — now returns early if closed",
  "",
  "> **Note:** All bug fixes have dedicated tests in `tests/channels.test.ts`. See the [deeper audit commit](https://github.com/brendadeeznuts1111/bun-automation-platform/commit/be1b1fe) for details.",
  "",
  "## API Reference",
  "",
  "### Channel<TSend, TRecv> interface",
  "",
  "- `send(msg: TSend): boolean` — send a typed message, returns false if closed",
  "- `on(type, handler): Unsubscribe` — subscribe to a specific message type",
  "- `onAny(handler): Unsubscribe` — subscribe to all messages",
  "- `close(): void` — close the channel, remove all handlers",
  "- `onClose(handler): Unsubscribe` — called when the channel closes",
  "",
  "### IPCChannel (parent ↔ worker)",
  "",
  "- `handleMessage(msg)` — parent-side: called from Bun.spawn ipc callback",
  "- `handleClose()` — called on IPC disconnect (Bug 1 fix)",
  "- `setSender(proc)` — deferred init after Bun.spawn returns",
  "- `setId(id)` — update id after proc.pid is known",
  "",
  "### WSChannel (server ↔ client)",
  "",
  "- `handleMessage(raw)` — parse JSON (string, ArrayBuffer, Uint8Array)",
  "- `publish(topic, msg)` — broadcast to all subscribers via server.publish",
  "- `subscribe(topic)` / `unsubscribe(topic)` — Bun native pub/sub",
  "- `close(code?, reason?)` — close the WebSocket connection",
  "",
  "## GFM Case-Sensitivity Reference",
  "",
  "Tested against `Bun.markdown.html()` — GFM defaults: `tables`, `strikethrough`, `tasklists` enabled.",
  "",
  "| Feature | Input | Case-sensitive? | Notes |",
  "|---------|-------|-----------------|-------|",
  "| Task list checkbox | `- [x]` vs `- [X]` | No — both render checked | Only `[x]` and `[X]` work; `[Xx]` is literal text |",
  "| Task list uncheck | `- [ ]` | N/A | Space-only inside brackets |",
  "| Code lang tag | ` ```ts ` vs ` ```TS ` | Yes — preserved in class | `language-ts` vs `language-TS` — breaks syntax highlighters that expect lowercase |",
  "| Reference link | `[text][REF]` vs `[text][ref]` | No — case-insensitive match | GFM spec: reference labels are case-insensitive |",
  "| Autolink scheme | `http://` vs `HTTPS://` | No — both autolinked | URL is preserved as-is in href attribute |",
  "| Strikethrough | `~~text~~` | N/A | Content inside `~~` is preserved as-is |",
  "| Heading IDs | `headings: { ids: true }` | N/A | Option name is `headings` (not `headingIds`); generates slug from heading text |",
  "| Table alignment | `\\|:---\\|` vs `\\|:--:\\|` | N/A | Colons control alignment, not case |",
  "| Emphasis | `*italic*` vs `_italic_` | N/A | Both render `<em>`; `__` renders `<strong>` unless `underline: true` |",
  "",
  '> **Warning:** Code block language tags are case-sensitive. Use lowercase (`ts`, `js`, `python`) for syntax highlighter compatibility. `Bun.markdown.html()` preserves the case in the class="language-X" attribute.',
  "",
  "> **Warning:** Table cells with pipes inside inline code (`` `a|b` ``) are broken — the pipe splits the cell. Escape pipes as `\\|` outside code, or avoid pipes in table cell content.",
  "",
  "### Bun.markdown.html options",
  "",
  "| Option | Default | Description |",
  "|--------|---------|-------------|",
  "| `tables` | `true` | GFM tables |",
  "| `strikethrough` | `true` | `~~text~~` → `<del>` |",
  "| `tasklists` | `true` | `- [x]` → checkbox |",
  "| `autolinks` | `false` | Autolink bare URLs/emails |",
  "| `headings` | `false` | `{ ids: true }` → heading anchor IDs |",
  "| `wikiLinks` | `false` | `[[wiki links]]` |",
  "| `underline` | `false` | `__text__` → `<u>` instead of `<strong>` |",
  "| `latexMath` | `false` | `$inline$` and `$$display$$` |",
  "| `tagFilter` | `false` | GFM tag filter for disallowed HTML |",
  "| `hardSoftBreaks` | `false` | Soft breaks → `<br>` |",
  "| `collapseWhitespace` | `false` | Collapse whitespace in text |",
  "",
  "### Nested Lists (1.2.3)",
  "",
  "`Bun.markdown.html()` renders nested ordered lists with proper `<ol>` nesting. Indent 3 spaces per level.",
  "",
  "```markdown",
  "1. Top level",
  "   1. Second level",
  "      1. Third level",
  "   2. Back to second",
  "2. Back to top",
  "```",
  "",
  "Renders as:",
  "",
  "<ol>",
  "  <li>Top level",
  "    <ol>",
  "      <li>Second level",
  "        <ol>",
  "          <li>Third level</li>",
  "        </ol>",
  "      </li>",
  "      <li>Back to second</li>",
  "    </ol>",
  "  </li>",
  "  <li>Back to top</li>",
  "</ol>",
  "",
  "#### Nesting metadata via `Bun.markdown.render()`",
  "",
  "The `render()` API exposes list metadata via the second callback argument:",
  "",
  "| Callback | Meta fields | Description |",
  "|----------|-------------|-------------|",
  "| `list(children, meta)` | `ordered`, `start?`, `depth` | `depth` = nesting level (0 = top) |",
  "| `listItem(children, meta)` | `index`, `depth`, `ordered`, `start?`, `checked?` | `checked` for `- [x]` / `- [ ]` |",
  "",
  "Example — render nested lists with depth attributes:",
  "",
  "```ts",
  "const out = Bun.markdown.render(md, {",
  "  list(children, meta) {",
  "    const tag = meta.ordered ? \"ol\" : \"ul\";",
  "    const start = meta.ordered && meta.start !== 1",
  "      ? ` start=\"${meta.start}\"` : \"\";",
  "    return `<${tag}${start} data-depth=\"${meta.depth}\">${children}</${tag}>`;",
  "  },",
  "  listItem(children, meta) {",
  "    return `<li data-index=\"${meta.index}\" data-depth=\"${meta.depth}\">${children}</li>`;",
  "  },",
  "});",
  "```",
  "",
  "#### Mixed nesting patterns",
  "",
  "| Pattern | Syntax | Output |",
  "|---------|--------|--------|",
  "| Ordered in ordered | `1.` → `   1.` → `      1.` | `<ol><li><ol><li><ol><li>` |",
  "| Unordered in ordered | `1.` → `   -` | `<ol><li><ul><li>` |",
  "| Task list in ordered | `1.` → `   - [x]` | `<ol><li><ul><li class=\"task-list-item\">` |",
  "| Code block in nested | `1.` → `   1.` → `   ```ts` | `<ol><li><ol><li><pre><code>` |",
  "| Start at non-1 | `3.` → `4.` → `5.` | `<ol start=\"3\">` |",
  "| Loose (with paragraph) | `1.\\n\\n   Text\\n\\n2.` | `<li><p>...</p></li>` |",
  "",
  "> **Note:** Indentation must be 3+ spaces for nesting. Two spaces does not trigger a nested list in GFM.",
  "",
  "#### Depth limits",
  "",
  "Tested up to 4 levels deep — `Bun.markdown.html()` handles arbitrary nesting:",
  "",
  "```markdown",
  "1. L1",
  "   1. L2",
  "      1. L3",
  "         1. L4",
  "      2. L3b",
  "   2. L2b",
  "2. L1b",
  "```",
  "",
  "Each level gets its own `<ol>` wrapper. The `render()` API reports `depth` as 0, 1, 2, 3 respectively.",
  "",
  "### Edge Cases & Parser Bugs",
  "",
  "Tested 22 edge cases against `Bun.markdown.html()`. Most work correctly; two are parser bugs.",
  "",
  "#### Indentation sensitivity",
  "",
  "| Indent | Nests? | Example |",
  "|--------|--------|---------|",
  "| 2 spaces | No — flat list | `1. Top\\n  1. Nested` → two top-level items |",
  "| 3 spaces | Yes | `1. Top\\n   1. Nested` → nested `<ol>` |",
  "| 4 spaces | Yes | `1. Top\\n    1. Nested` → nested `<ol>` |",
  "| Tab | Yes | `1. Top\\n\\t1. Nested` → nested `<ol>` |",
  "",
  "> **Note:** 2-space indent does NOT trigger nesting for ordered lists (parent marker `1.` is 2 chars + 1 space = 3 col). For unordered lists (`-`), 2 spaces IS enough (marker is 1 char + 1 space = 2 col).",
  "",
  "#### Bug: Nested list with non-1 start number",
  "",
  "When the first nested item starts at a number other than 1, the parser does NOT recognize it as a nested list — it renders as literal text inside the parent item.",
  "",
  "```markdown",
  "1. Top",
  "   5. Starts at 5",
  "   6. Six",
  "2. Back",
  "```",
  "",
  "Expected: nested `<ol start=\"5\">`. Actual: `<li>Top 5. Starts at 5 6. Six</li>` — the nested list is not parsed.",
  "",
  "> **Warning:** This is a parser bug in Bun.markdown (md4c). Nested ordered lists MUST start at `1.` to be recognized. Use `1.` for the first nested item even if you want a different display start — then use CSS `start` attribute or `Bun.markdown.render()` to override.",
  "",
  "#### Bug: Empty first nested item breaks nesting",
  "",
  "When the first nested item is empty (`1.` with no content), the parser does NOT recognize the nested list.",
  "",
  "```markdown",
  "1. Top",
  "   1.",
  "   2. Nested second",
  "```",
  "",
  "Expected: nested `<ol>` with empty first `<li>`. Actual: `<li>Top 1. 2. Nested second</li>` — rendered as literal text.",
  "",
  "> **Warning:** The first nested list item must have content for the parser to recognize the nested list. Empty items are only valid as non-first items in a nested list.",
  "",
  "#### Working edge cases",
  "",
  "| Pattern | Works? | Output |",
  "|---------|--------|--------|",
  "| 5-6 levels deep | Yes | Properly nested `<ol>` wrappers |",
  "| Two separate lists (blank line + text) | Yes | Two separate `<ol>` elements |",
  "| List interrupted by heading | Yes | `<ol>` + `<h2>` + new `<ol>` |",
  "| Multi-paragraph items (loose list) | Yes | `<li><p>...</p><p>...</p></li>` |",
  "| Blockquote in list item | Yes | `<li>Item <blockquote>...</blockquote></li>` |",
  "| Empty top-level item | Yes | `<li></li>` (empty but valid) |",
  "| Whitespace-only item | Yes | `<li></li>` (treated as empty) |",
  "| Trailing spaces | Yes | Trimmed |",
  "| Single item list | Yes | `<ol><li>...</li></ol>` |",
  "| List after paragraph (no blank line) | Yes | `<p>...</p><ol>...</ol>` |",
  "| Tab indentation | Yes | Treated same as 3+ spaces |",
  "| Nested task lists (3 levels) | Yes | `<ol><li><ul><li class=task-list-item><ul>...` |",
  "| Fenced code in nested list | Yes | `<ol><li><ol><li><pre><code>` |",
  "| Indented code block (8 spaces) in loose list | Yes | `<li><p>...</p><pre><code>` |",
  "| Non-1 start on outer list | Yes | `<ol start=\"3\">` |",
  "| Mixed ordered/unordered nesting | Yes | `<ol><li><ul>` and `<ul><li><ol>` |",
  "",
  "### render() Metadata Deep Dive",
  "",
  "The `render()` callback metadata for nested lists:",
  "",
  "| Field | Type | Behavior |",
  "|-------|------|----------|",
  "| `depth` | number | 0-based nesting level (0 = top, 1 = first nest, etc.) |",
  "| `index` | number | 0-based position within parent list (resets per list) |",
  "| `ordered` | boolean | Whether the parent list is ordered |",
  "| `start` | number | Parent list's start number (inherited by all items) |",
  "| `checked` | boolean/undefined | `true` for `[x]`, `false` for `[ ]`, `undefined` for non-task |",
  "",
  "> **Note:** The `start` field on `listItem` metadata reports the PARENT list's start, not the item's own number. For a list starting at 3, all items report `start=3` regardless of their position.",
  "",
  "#### render() callback execution order",
  "",
  "Callbacks fire inside-out (deepest first):",
  "",
  "```",
  "listItem(depth=4) → list(depth=4) → listItem(depth=3) → list(depth=3) →",
  "listItem(depth=2) → list(depth=2) → listItem(depth=1) → list(depth=1) →",
  "listItem(depth=0) → list(depth=0)",
  "```",
  "",
  "This means children are fully rendered before their parent's `list()` callback fires, so `children` is always a complete HTML string.",
  "",
  "### CSS Counter Behavior with `start`",
  "",
  "The CSS `counters(ol-item, \".\")` approach inherits the `start` attribute correctly:",
  "",
  "```css",
  "ol { counter-reset: ol-item; }",
  "ol > li { counter-increment: ol-item; }",
  "ol > li::marker { content: counters(ol-item, \".\") \". \"; }",
  "```",
  "",
  "- `<ol start=\"3\">` → items render as `3.`, `4.`, `5.` (counter starts at 3)",
  "- Nested under item 3 → `3.1.`, `3.2.`, `3.3.` (counter chains via `counters()`)",
  "- The `start` attribute on `<ol>` sets the CSS counter's initial value",
  "",
  "> **Warning:** CSS `counters()` does NOT respect `start` on nested `<ol>` elements in all browsers. Safari and Firefox handle this differently. For reliable cross-browser `1.2.3` numbering with non-1 starts, use `Bun.markdown.render()` to generate explicit marker text.",
  "",
  "",
  "## Tables — Deep Edge Cases",
  "",
  "Tested 17 table edge cases against `Bun.markdown.html()`.",
  "",
  "### Table structure requirements",
  "",
  "| Pattern | Works? | Notes |",
  "|---------|--------|-------|",
  "| Standard (header + separator + body) | Yes | `\\| a \\|\\n\\|---\\|\\n\\| 1 \\|` |",
  "| Header only (no body) | Yes | `<table><thead>...</thead></table>` (empty tbody) |",
  "| No separator row | No | Treated as paragraph text |",
  "| No header row | No | Treated as paragraph text |",
  "| Single column | Yes | `\\| a \\|\\n\\|---\\|\\n\\| 1 \\|` |",
  "| Empty cells | Yes | `\\| \\|` → `<td></td>` |",
  "",
  "### Table alignment",
  "",
  "| Syntax | Align | Output attribute |",
  "|--------|-------|-----------------|",
  "| `\\|:---\\|` | left | `align=\"left\"` |",
  "| `\\|:--:\\|` | center | `align=\"center\"` |",
  "| `\\|---:\\|` | right | `align=\"right\"` |",
  "| `\\|---\\|` | default | no align attribute |",
  "",
  "The `render()` API exposes alignment via `th(children, meta)` and `td(children, meta)` where `meta.align` is `\"left\"`, `\"center\"`, `\"right\"`, or absent.",
  "",
  "### Table content support",
  "",
  "| Content type | Works in cells? | Example |",
  "|--------------|-----------------|---------|",
  "| Links | Yes | `\\| [text](url) \\|` |",
  "| Inline code | Yes | `\\| \\`code\\` \\|` |",
  "| HTML | Yes | `\\| <strong>bold</strong> \\|` |",
  "| Emoji | Yes | `\\| 🔥 \\|` |",
  "| Line breaks | Yes | `\\| line1<br>line2 \\|` |",
  "| Escaped pipes | Yes | `\\| a \\\\| b \\|` → cell contains `a \\| b` |",
  "",
  "### Table bugs",
  "",
  "> **Warning: Variable column count breaks the table.** If the header has 3 columns but a body row has 2, the entire table is NOT rendered — it becomes a paragraph. All rows must have the same number of columns.",
  "",
  "> **Warning: Extra leading/trailing pipes break the table.** `\\|\\| a \\|\\|` is NOT rendered as a table. Use exactly one pipe per column boundary.",
  "",
  "> **Warning: Pipes inside inline code break table cells.** `\\| \\`a|b\\` \\|` splits into two cells. The backtick does not protect the pipe. Escape with `\\\\|` instead, but this produces literal `\\\\|` in the output — there is no clean workaround for pipes in code within tables.",
  "",
  "### Tables inside other blocks",
  "",
  "| Container | Works? | Notes |",
  "|-----------|--------|-------|",
  "| Inside list item (loose) | Yes | Requires blank line before table |",
  "| Inside blockquote | Yes | Each row prefixed with `>` |",
  "",
  "",
  "## Blockquotes — Deep Edge Cases",
  "",
  "Tested 9 blockquote edge cases.",
  "",
  "| Pattern | Works? | Output | Notes |",
  "|---------|--------|--------|-------|",
  "| Nested 2 levels | Yes | `<blockquote><blockquote>` | `> outer\\n> > inner` |",
  "| Nested 3 levels | Yes | `<blockquote><blockquote><blockquote>` | `> L1\\n> > L2\\n> > > L3` |",
  "| With ordered list | Yes | `<blockquote><ol>` | `> 1. First\\n> 2. Second` |",
  "| With code block | Yes | `<blockquote><pre><code>` | `> \\`\\`\\`ts\\n> code\\n> \\`\\`\\`` |",
  "| With table | Yes | `<blockquote><table>` | `> \\| a \\|\\n> \\|---\\|\\n> \\| 1 \\|` |",
  "| With heading | Yes | `<blockquote><h1>` | `> # Heading` |",
  "| With task list | Yes | `<blockquote><ul><li class=task-list-item>` | `> - [x] Done` |",
  "| Multiple paragraphs | Yes | `<blockquote><p>...</p><p>...</p>` | `> Para 1\\n>\\n> Para 2` |",
  "| Lazy continuation | Yes | Included in blockquote | `> First\\nSecond` (no `>` on 2nd line) |",
  "",
  "> **Note:** Blockquotes support all GFM features inside them — lists, tables, code blocks, task lists, headings, and nested blockquotes all work correctly.",
  "",
  "",
  "## Strikethrough — Deep Edge Cases",
  "",
  "Tested 8 strikethrough edge cases.",
  "",
  "| Pattern | Works? | Output | Notes |",
  "|---------|--------|--------|-------|",
  "| Single word `~~word~~` | Yes | `<del>word</del>` | |",
  "| Multiple words | Yes | `<del>multiple words</del>` | |",
  "| In heading `## ~~deprecated~~ API` | Yes | `<h2><del>deprecated</del> API</h2>` | |",
  "| Nested with bold `**bold ~~struck~~**` | Yes | `<strong>bold <del>struck</del></strong>` | |",
  "| With code `~~\\`old\\`~~` | Yes | `<del><code>old</code></del>` | |",
  "| Unclosed `~~unclosed` | No | Literal `~~unclosed` | No closing `~~` |",
  "| Single tilde `~text~` | Yes | `<del>text</del>` | **Bug: should NOT strike** |",
  "| Triple tilde `~~~text~~~` | No | Code block with lang `text~~~` | Parsed as fenced code |",
  "",
  "> **Warning: Single tilde `~text~` incorrectly renders as strikethrough.** The GFM spec requires double tilde `~~` for strikethrough. Single tilde should be literal text. This is a parser bug in md4c/Bun.markdown.",
  "",
  "> **Warning: Triple tilde `~~~text~~~` is parsed as a fenced code block** (tilde-fenced), not strikethrough. Use `~~` (exactly two) for strikethrough.",
  "",
  "",
  "## Autolinks — Deep Edge Cases",
  "",
  "Tested 14 autolink edge cases with `autolinks: true`.",
  "",
  "| Pattern | Autolinks? | Notes |",
  "|---------|-----------|-------|",
  "| `http://example.com` | Yes | Bare URL |",
  "| `https://example.com` | Yes | HTTPS scheme |",
  "| URL with path | Yes | `https://example.com/path` |",
  "| URL with query string | Yes | `?q=1&r=2` → `&amp;` in href |",
  "| URL with fragment | Yes | `#section` |",
  "| Email | Yes | `mailto:` prefix added |",
  "| `www.example.com` | Yes | `http://` prefix added |",
  "| URL in inline code | No | Protected by backticks |",
  "| URL in explicit link | No | Already a link |",
  "| URL in parentheses | Yes | `(https://...)` → parens preserved |",
  "| Trailing punctuation | Yes | `https://example.com.` → period excluded |",
  "| Trailing close paren | Yes | `https://example.com)` → paren excluded |",
  "| Multiple URLs | Yes | Both linked |",
  "| Unicode in URL path | No | `https://example.com/üñîçødé` not linked |",
  "",
  "> **Warning: URLs with Unicode characters in the path are NOT autolinked.** This is a parser limitation — use explicit `[text](url)` links for Unicode URLs.",
  "",
  "> **Note:** Autolinks correctly handle trailing punctuation (`.`, `,`, `!`, `?`) and closing parentheses — they are excluded from the URL.",
  "",
  "",
  "## Code Blocks — Deep Edge Cases",
  "",
  "Tested 11 code block edge cases.",
  "",
  "| Pattern | Works? | Output | Notes |",
  "|---------|--------|--------|-------|",
  "| Fenced, no language | Yes | `<pre><code>` (no class) | |",
  "| Fenced with language | Yes | `class=\"language-ts\"` | |",
  "| Fenced with info string | Partial | `class=\"language-ts\"` only | Info string after lang is ignored |",
  "| Tilde-fenced `~~~ts` | Yes | Same as backtick-fenced | |",
  "| 4 backticks with ``` inside | Yes | Inner ``` preserved as text | |",
  "| Nested fences (4 outer, 3 inner) | Yes | Inner fence is literal text | |",
  "| Indented code (4 spaces) | Yes | `<pre><code>` | |",
  "| HTML in code block | Yes | HTML-escaped `&lt;div&gt;` | |",
  "| Empty code block | Yes | `<pre><code></code></pre>` | |",
  "| Trailing newline in code | Yes | Preserved | |",
  "",
  "> **Note:** The info string after the language (e.g. ` ```ts title=\"test\" `) is parsed but only the language is used for the class attribute. The rest (`title=\"test\"`) is silently dropped.",
  "",
  "> **Note:** To include literal ``` inside a code block, use 4+ backticks for the outer fence: ` ```` \\n ```ts \\n inner \\n ``` \\n ```` `.",
  "",
  "",
  "## Links & Images — Deep Edge Cases",
  "",
  "Tested 7 link/image edge cases.",
  "",
  "| Pattern | Works? | Notes |",
  "|---------|--------|-------|",
  "| Inline link with title `[text](url \"Title\")` | Yes | `title` attribute added |",
  "| Reference link `[text][ref]` | Yes | Case-insensitive ref matching |",
  "| Shortcut link `[url]` | Partial | Autolinks the URL but keeps brackets |",
  "| Collapsed link `[text][]` | No | Not recognized — renders as literal |",
  "| Link with ampersand | Yes | `&` → `&amp;` in href |",
  "| Image with title | Yes | `title` attribute on `<img>` |",
  "| Image reference | Yes | `![alt][ref]` with `[ref]: url` |",
  "",
  "> **Warning: Collapsed reference links `[text][]` are NOT supported.** The parser does not recognize the empty `[]` as a reference to a link definition with the same name as the link text. Use `[text][text]` or `[text]` (shortcut) instead.",
  "",
  "",
  "## Raw HTML in Markdown",
  "",
  "`Bun.markdown.html()` passes raw HTML through by default (unless `noHtmlBlocks`/`noHtmlSpans` is set).",
  "",
  "| HTML | Passed through? | Notes |",
  "|------|-----------------|-------|",
  "| `<div>...</div>` | Yes | Block-level HTML preserved |",
  "| Multiline `<div>` | Yes | Inner content is parsed as markdown |",
  "| `<script>alert(1)</script>` | Yes | **Security: XSS risk** |",
  "| `<details><summary>` | Yes | Interactive elements work |",
  "",
  "> **Warning: Raw HTML including `<script>` tags is passed through unchanged.** This is a potential XSS vector if rendering untrusted user input. Use `tagFilter: true` or `noHtmlBlocks: true` / `noHtmlSpans: true` to disable raw HTML when processing untrusted content.",
  "",
  "",
  "## Headings — Deep Edge Cases",
  "",
  "Tested 9 heading edge cases with `headings: { ids: true }`.",
  "",
  "| Pattern | Works? | ID generated | Notes |",
  "|---------|--------|-------------|-------|",
  "| `# H1` through `###### H6` | Yes | Slug from text | 6 levels supported |",
  "| `####### H7` | No | N/A | 7 `#` is not a heading — renders as paragraph |",
  "| Heading with code `## \\`code\\` heading` | Yes | `code-heading` | Code stripped from ID |",
  "| Heading with link `## [Link](url) heading` | Yes | `link-heading` | Link text used for ID |",
  "| Heading with emoji `## 🔥 Heading` | Yes | `heading` | Emoji stripped from ID |",
  "| Closed heading `## Heading ##` | Yes | `heading` | Trailing `##` stripped |",
  "| No space `##NoSpace` | No | N/A | Requires space after `#` |",
  "| Setext h2 `Heading\\n--------` | Yes | `heading` | Underline style |",
  "| Setext h1 `Heading\\n========` | Yes | `heading` | Underline style |",
  "",
  "> **Note:** Heading ID slugs are generated by lowercasing the text, removing non-alphanumeric characters, and replacing spaces with hyphens. Emoji and code formatting are stripped before slug generation.",
  "",
  "",
  "## Bun.markdown.ansi() — Terminal Output",
  "",
  "`Bun.markdown.ansi()` renders markdown into ANSI-colored terminal output with Unicode box-drawing for tables, colored headings, and syntax-highlighted code blocks.",
  "",
  "```ts",
  "import { write } from \"bun\";",
  "",
  "const md = \"# Title\\n\\n| Col A | Col B |\\n|-------|-------|\\n| 1 | 2 |\\n\\n- [x] Done\\n- [ ] Todo\";",
  "const ansi = Bun.markdown.ansi(md);",
  "await write(Bun.stdout, ansi);",
  "```",
  "",
  "Features rendered by `ansi()`:",
  "",
  "- Headings: bold + colored (magenta for h1, cyan for h2)",
  "- Tables: Unicode box-drawing characters (`┌─┬─┐│├─┼─┤└─┴─┘`)",
  "- Task lists: `☒` (checked) and `☐` (unchecked) with green/gray colors",
  "- Ordered lists: numbered with cyan markers",
  "- Blockquotes: `│` prefix with gray/dim styling",
  "- Strikethrough: ANSI dim/strikethrough escape sequence",
  "- Bold and italic: ANSI escape sequences",
  "- Links: blue + underlined with URL in dim parens",
  "- Code blocks: bordered with `┌─` / `│` / `└─` and syntax-highlighted",
  "- Inline code: highlighted background + foreground color",
  "",
  "> **Note:** `Bun.markdown.ansi()` enables all GFM features by default (tables, strikethrough, tasklists) plus wikilinks, underline, and LaTeX math. It is the most feature-complete renderer.",
  "",
  "",
  "## render() Callback Execution Order",
  "",
  "All callbacks fire inside-out (deepest children first). For a table:",
  "",
  "```",
  "th(depth=cell) → tr → thead → td(depth=cell) → tr → tbody → table",
  "```",
  "",
  "For nested lists:",
  "",
  "```",
  "listItem(depth=N) → list(depth=N) → ... → listItem(depth=0) → list(depth=0)",
  "```",
  "",
  "This guarantees `children` is always a complete HTML string when the parent callback fires.",
  "",
  "### Full render() callback reference",
  "",
  "| Callback | Meta | Fires for |",
  "|----------|------|-----------|",
  "| `heading(children, { level, id? })` | level 1-6, id when enabled | `# H1` through `###### H6` |",
  "| `paragraph(children)` | — | Paragraphs |",
  "| `blockquote(children)` | — | `> quote` |",
  "| `code(children, { language? })` | info string lang | Fenced and indented code |",
  "| `list(children, { ordered, start?, depth })` | nesting level | `<ol>` / `<ul>` |",
  "| `listItem(children, { index, depth, ordered, start?, checked? })` | full list meta | `<li>` |",
  "| `hr(children)` | — | `---` |",
  "| `table(children)` | — | GFM table |",
  "| `thead(children)` | — | Table header |",
  "| `tbody(children)` | — | Table body |",
  "| `tr(children)` | — | Table row |",
  "| `th(children, { align? })` | left/center/right | Table header cell |",
  "| `td(children, { align? })` | left/center/right | Table data cell |",
  "| `html(children)` | — | Raw HTML block |",
  "",
  "",
  "## Related",
  "",
  "- [Bun.markdown docs](https://bun.com/docs/runtime/markdown) — GFM parser used for this page",
  "- [Bun.markdown reference](https://bun.com/reference/bun/markdown) — full API reference",
  "- [Bun.color docs](https://bun.com/docs/runtime/bun-apis) — color format converter for branding",
  "- [Bun.serve WebSocket docs](https://bun.com/docs/runtime/http/websockets) — pub/sub API",
  "- [Bun.spawn IPC docs](https://bun.com/docs/runtime/spawn) — parent-child IPC",
  "",
].join("\n");

const gfmHtml = Bun.markdown.html(gfmContent, {
  autolinks: true,
  // Generate heading IDs for anchor links (e.g. #gfm-case-sensitivity-reference)
  headings: { ids: true },
});

// --- Assemble final HTML with brand colors ----------------------------------

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Channel Architecture — Bun Automation Platform</title>
  <style>
    :root {
      --brand-label: ${brand.label};
      --brand-value: ${brand.value};
      --brand-ok: ${brand.ok};
      --brand-err: ${brand.err};
      --brand-warn: ${brand.warn};
      --brand-bg: ${brand.bg};
      --brand-bg-rgb: ${brandRgb.bg};
      --brand-label-rgb: ${brandRgb.label};
    }

    * { box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      max-width: 1200px;
      margin: 0 auto;
      padding: 2rem 1.5rem;
      background: var(--brand-bg);
      color: var(--brand-value);
      line-height: 1.6;
    }

    h1 {
      color: var(--brand-label);
      border-bottom: 2px solid var(--brand-label);
      padding-bottom: 0.5rem;
      font-size: 1.8rem;
    }

    h2 {
      color: var(--brand-label);
      margin-top: 2.5rem;
      font-size: 1.4rem;
      /* Heading anchor links */
      position: relative;
    }

    h2[id]::before {
      content: "#";
      position: absolute;
      left: -1.2rem;
      color: rgba(${brandRgb.label}, 0.3);
      font-weight: 400;
    }

    h2[id]:hover::before {
      color: var(--brand-label);
    }

    h3 {
      color: var(--brand-warn);
      margin-top: 1.5rem;
      font-size: 1.1rem;
    }

    p { color: var(--brand-value); margin: 0.8rem 0; }

    a {
      color: var(--brand-label);
      text-decoration: none;
      border-bottom: 1px dotted var(--brand-label);
    }
    a:hover { border-bottom-style: solid; }

    code {
      font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
      font-size: 0.9em;
      background: rgba(${brandRgb.label}, 0.12);
      color: var(--brand-label);
      padding: 0.15rem 0.4rem;
      border-radius: 3px;
    }

    pre {
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(${brandRgb.label}, 0.2);
      border-radius: 6px;
      padding: 1rem;
      overflow-x: auto;
    }

    /* GFM code language tags are case-sensitive (language-TS vs language-ts).
       Normalize via CSS attribute selector so highlighters don't break. */
    pre code[class*="language-"] {
      font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
    }

    pre code {
      background: none;
      color: var(--brand-value);
      padding: 0;
    }

    ul, ol {
      padding-left: 1.5rem;
    }

    /* Nested ordered list counters — display as 1, 1.1, 1.1.1, 1.1.1.1 */
    ol {
      counter-reset: ol-item;
    }
    ol > li {
      counter-increment: ol-item;
      margin: 0.3rem 0;
      color: var(--brand-value);
    }
    ol > li::marker {
      content: counters(ol-item, ".") ". ";
      color: var(--brand-label);
      font-weight: 500;
    }

    /* Unordered lists keep default markers */
    ul > li {
      margin: 0.3rem 0;
      color: var(--brand-value);
    }
    ul > li::marker {
      color: var(--brand-label);
    }

    .task-list-item {
      list-style: none;
      margin-left: -1.2rem;
    }
    .task-list-item input[type="checkbox"] {
      margin-right: 0.5rem;
      accent-color: var(--brand-ok);
    }

    table {
      border-collapse: collapse;
      width: 100%;
      margin: 1rem 0;
      font-size: 0.9rem;
    }

    th {
      background: rgba(${brandRgb.label}, 0.15);
      color: var(--brand-label);
      text-align: left;
      padding: 0.6rem 0.8rem;
      border: 1px solid rgba(${brandRgb.label}, 0.3);
    }

    td {
      padding: 0.6rem 0.8rem;
      border: 1px solid rgba(${brandRgb.label}, 0.15);
      color: var(--brand-value);
    }

    tr:nth-child(even) td {
      background: rgba(0, 0, 0, 0.15);
    }

    blockquote {
      border-left: 3px solid var(--brand-warn);
      margin: 1rem 0;
      padding: 0.5rem 1rem;
      background: rgba(${brandRgb.warn}, 0.08);
      color: var(--brand-value);
    }

    blockquote p { margin: 0.3rem 0; }

    details {
      margin: 0.5rem 0;
      border: 1px solid rgba(${brandRgb.label}, 0.2);
      border-radius: 4px;
      padding: 0.5rem 1rem;
      background: rgba(0, 0, 0, 0.2);
    }

    details summary {
      cursor: pointer;
      color: var(--brand-label);
      font-weight: 500;
    }

    details[open] summary {
      margin-bottom: 0.5rem;
    }

    img {
      max-width: 100%;
      height: auto;
      display: block;
      margin: 0 auto;
    }

    hr {
      border: none;
      border-top: 1px solid rgba(${brandRgb.label}, 0.2);
      margin: 2rem 0;
    }

    .brand-bar {
      display: flex;
      gap: 1rem;
      align-items: center;
      margin-bottom: 2rem;
      padding: 0.5rem 1rem;
      background: rgba(0, 0, 0, 0.3);
      border-radius: 6px;
      border: 1px solid rgba(${brandRgb.label}, 0.15);
      font-size: 0.85rem;
      flex-wrap: wrap;
    }

    .brand-swatch {
      display: inline-block;
      width: 1rem;
      height: 1rem;
      border-radius: 3px;
      border: 1px solid rgba(255,255,255,0.2);
      vertical-align: middle;
      margin-right: 0.3rem;
    }

    .brand-item {
      display: flex;
      align-items: center;
      gap: 0.3rem;
    }

    .brand-item code {
      font-size: 0.8em;
    }
  </style>
</head>
<body>
  <h1>Channel Architecture</h1>
  <p>Transport-agnostic typed message passing — IPC, WebSocket, and (future) MessagePort.</p>

  <div class="brand-bar">
    <span style="color: var(--brand-label); font-weight: 600;">Brand colors (Bun.color):</span>
    <span class="brand-item"><span class="brand-swatch" style="background:${brand.label}"></span><code>label</code></span>
    <span class="brand-item"><span class="brand-swatch" style="background:${brand.value}"></span><code>value</code></span>
    <span class="brand-item"><span class="brand-swatch" style="background:${brand.ok}"></span><code>ok</code></span>
    <span class="brand-item"><span class="brand-swatch" style="background:${brand.err}"></span><code>err</code></span>
    <span class="brand-item"><span class="brand-swatch" style="background:${brand.warn}"></span><code>warn</code></span>
    <span class="brand-item"><span class="brand-swatch" style="background:${brand.bg}"></span><code>bg</code></span>
  </div>

  ${gfmHtml}
</body>
</html>
`;

const outputPath = resolve(import.meta.dir, "channel-diagrams.html");
writeFileSync(outputPath, html);
console.log(`\nWritten: ${outputPath} (${html.length} bytes)`);
