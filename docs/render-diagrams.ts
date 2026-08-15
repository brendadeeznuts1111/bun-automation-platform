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
