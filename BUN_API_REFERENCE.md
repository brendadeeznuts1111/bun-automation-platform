# Bun Native APIs: Complete Reference Table

This table maps every Bun API used in the automation platform to its **version**, **release blog**, **documentation**, **stability**, and a **code example**. All links are to canonical Bun sources.

---

## Legend

- **Stable** — Safe for production; follows semver.
- **Experimental** — May change in future releases (marked in docs).
- **Unstable** — Under active development; may change without semver guarantee.
- **Built-in** — Available without imports.

---

## Main API Table

| API / Feature | Version Introduced | Release Blog / Docs | Stability | Code Example | Notes |
|---------------|-------------------|----------------------|-----------|--------------|-------|
| **`Bun.serve`** | Built-in | [Docs](https://bun.com/docs/runtime/bun-apis) | Stable | `Bun.serve({ fetch(req) { return new Response("OK"); } });` | HTTP/HTTPS server with WebSocket support; TLS built-in. |
| **`Bun.WebView`** | v1.3.12 | [Blog](https://bun.com/blog/bun-v1.3.12) · [Docs](https://bun.com/docs/runtime/webview) | Experimental | `await using view = new Bun.WebView(); await view.navigate("https://example.com");` | Headless browser; uses WebKit on macOS, Chrome/CDP elsewhere. |
| **`Bun.Image`** | v1.3.14 | [Blog](https://bun.com/blog/bun-v1.3.14) · [Docs](https://bun.com/docs/runtime/image) | Stable | `await Bun.file("photo.jpg").image().resize(400).webp().write("thumb.webp");` | Chainable image pipeline (JPEG, PNG, WebP, HEIC, AVIF). |
| **`Bun.cron`** (in-process) | v1.3.11 | [Blog](https://bun.com/blog/bun-v1.3.11) · [Docs](https://bun.com/docs/runtime/cron) | Stable | `Bun.cron("*/5 * * * *", async () => { await checkHealth(); });` | Schedules callbacks; no-overlap guarantee; fake timers support. |
| **`Bun.cron`** (OS-level) | v1.3.11 | [Blog](https://bun.com/blog/bun-v1.3.11) · [Docs](https://bun.com/docs/runtime/cron) | Stable | `await Bun.cron("./worker.ts", "0 2 * * *", "daily-job");` | Registers system cron jobs; works on Linux/macOS/Windows. |
| **`Bun.spawn`** | Built-in | [Docs](https://bun.com/docs/runtime/spawn) | Stable | `const proc = Bun.spawn(["bun", "worker.ts"], { ipc: (msg) => {} });` | Spawn child processes with IPC; `--no-orphans` added in v1.3.14. |
| **`process.execve`** | v1.3.14 | [Blog](https://bun.com/blog/bun-v1.3.14) | Stable | `process.execve("/usr/bin/echo", ["echo", "hi"], process.env);` | Replace current process image; POSIX syscall; no return on success. |
| **`Bun.Terminal`** (ConPTY) | v1.3.14 (Windows) | [Blog](https://bun.com/blog/bun-v1.3.14) · [Docs](https://bun.com/docs/runtime/spawn#terminal) | Stable | `const term = new Bun.Terminal({ cols: 80, rows: 24, data: (t, d) => process.stdout.write(d) });` | Cross-platform PTY; Windows ConPTY supported from v1.3.14. |
| **`Bun.CSRF`** | Built-in | [Docs](https://bun.com/docs/runtime/csrf) | Stable | `const token = Bun.CSRF.generate(secret, { sessionId }); if (Bun.CSRF.verify(token, { secret, sessionId })) ...` | Generate/verify CSRF tokens; HMAC-signed; binds to session. |
| **`Bun.CookieMap`** | v1.2.7 | [Blog](https://bun.com/blog/bun-v1.2.7) | Stable | `const cookies = req.cookies; cookies.set("session", id, { httpOnly: true });` | Map-like cookie management in `Bun.serve`. |
| **`Bun.password`** | Built-in | [Docs](https://bun.com/docs/runtime/bun-apis) | Stable | `const hash = await Bun.password.hash("secret"); const ok = await Bun.password.verify("secret", hash);` | Argon2id (default) and bcrypt; async/sync. |
| **`Bun.secrets`** | Built-in | [Docs](https://bun.com/docs/runtime/secrets) | Experimental | `await Bun.secrets.set({ service: "app", name: "key", value: "secret" });` | OS keychain storage (macOS, Linux, Windows). |
| **`Bun.color`** | v1.1.30 | [Blog](https://bun.com/blog/bun-v1.1.30) · [Docs](https://bun.com/docs/runtime/bun-apis) | Stable | `const c = Bun.color("#3b82f6", "hex"); // "#3b82f6" or null` | Format converter: `Bun.color(input, outputFormat?)` returns `string \| number \| object \| array \| null`. Formats: `"css"`, `"ansi"`, `"ansi-16"`, `"ansi-256"`, `"ansi-16m"`, `"number"`, `"hex"`, `"HEX"`, `"{rgb}"`, `"{rgba}"`, `"[rgb]"`, `"[rgba]"`, `"hsl"`, `"rgb"`, `"rgba"`. Validation via `=== null`. |
| **`Bun.markdown`** (`html`, `render`, `react`) | v1.3.8 | [Blog](https://bun.com/blog/bun-v1.3.8) · [Docs](https://bun.com/docs/runtime/markdown) · [Ref](https://bun.com/reference/bun/markdown) | Unstable | `const html = Bun.markdown.html("# Hello **world**", { autolinks: true });` | Built-in Markdown parser (Zig port of `md4c`). GFM defaults: `tables`, `strikethrough`, `tasklists`. See [Bun.markdown detail](#bunmarkdown-detail) below. |
| **`Bun.markdown.ansi()`** | v1.3.12 | [Blog](https://bun.com/blog/bun-v1.3.12) · [Ref](https://bun.com/reference/bun/markdown/ansi) | Unstable | `const out = Bun.markdown.ansi("# Hello", { hyperlinks: true }); process.stdout.write(out);` | ANSI-colored terminal output. Enables all GFM + wikilinks + underline + LaTeX math by default. Also enables `bun ./file.md` CLI. v1.3.14 fixed crash on invalid UTF-8 bytes. Not in the docs page — only in reference + blog. |
| **`Bun.env` / `process.env`** | Built-in | [Docs](https://bun.com/docs/runtime/env) | Stable | `const key = process.env.MASTER_KEY;` | Auto-loads `.env` files; aliases `Bun.env`. |
| **`Bun.write` / `Bun.file`** | Built-in | [Docs](https://bun.com/docs/runtime/bun-apis) | Stable | `await Bun.write("out.png", screenshot); const file = Bun.file("in.png");` | File/S3 operations; handles Blob, Buffer, streams. |
| **`bun:sqlite`** | Built-in | [Docs](https://bun.com/docs/runtime/bun-apis) | Stable | `import { Database } from "bun:sqlite"; const db = new Database("data.db");` | SQLite3 built-in; supports prepared statements. |
| **`console` with `%j`** | v1.3.4 | [Blog](https://bun.com/blog/bun-v1.3.4) | Stable | `console.log("%j", { foo: "bar" });` | JSON-formatted logging; matches Node.js behaviour. |
| **`--define`** | Built-in | [Docs](https://bun.com/docs/guides/runtime/define-constant) | Stable | `bun run --define process.env.NODE_ENV="'production'" index.ts` | Replace identifiers/properties at transpile time. |
| **`bun build --compile`** | Built-in | [Docs](https://bun.com/docs/bundler/compile) | Stable | `bun build --compile --minify src/server.ts --outfile server` | Creates standalone executable; v1.3.4 added runtime config skip. |
| **HTTP/3 client in `fetch()`** | v1.3.14 | [Blog](https://bun.com/blog/bun-v1.3.14) | Stable | `fetch("https://cloudflare.com")` automatically uses HTTP/3 if supported. | Experimental HTTP/3 and HTTP/2 clients; QUIC support. |
| **Shared SSL_CTX cache** | v1.3.14 | [Blog](https://bun.com/blog/bun-v1.3.14) | Stable | All TLS connections share a single SSL context. | Reduces memory from ~50 KB per connection to shared; affects Postgres, MongoDB, etc. |
| **`fs.watch` rewritten** | v1.3.14 | [Blog](https://bun.com/blog/bun-v1.3.14) | Stable | `fs.watch("./config", (event, filename) => { ... });` | Recursive watching; handles deleted/recreated files; single thread on macOS. |
| **WebSocket `perMessageDeflate: false`** | v1.3.14 | [Blog](https://bun.com/blog/bun-v1.3.14) | Stable | `new WebSocket("wss://...", { perMessageDeflate: false });` | Suppresses extension header for gateway compatibility. |
| **`SIGHUP` / `SIGBREAK` on Windows** | v1.3.14 | [Blog](https://bun.com/blog/bun-v1.3.14) | Stable | `process.on("SIGHUP", () => { cleanup(); });` | Console close (`CTRL_CLOSE_EVENT`) maps to `SIGHUP`; `CTRL_BREAK_EVENT` to `SIGBREAK`. |
| **Native `using` / `await using`** | v1.3.14 | [Blog](https://bun.com/blog/bun-v1.3.14#using-await-using-no-longer-lowered-when-targeting-bun) | Stable | `{ using view = new Bun.WebView(); }` | No transpilation when target `bun`; JavaScriptCore native support. |
| **`Bun.spawn` `--no-orphans`** | v1.3.14 | [Blog](https://bun.com/blog/bun-v1.3.14) | Stable | `bun --no-orphans src/server.ts` | Kernel-guaranteed child process cleanup on parent death. |
| **FreeBSD & Android builds** | v1.3.14 | [Blog](https://bun.com/blog/bun-v1.3.14) | Stable | Officially supported platforms. | Run Bun on routers, IoT, Android devices. |

---

## `Bun.markdown` Detail

> **Stability: Unstable** — "This API is under active development and may change in future versions of Bun."
>
> Grounded in [Markdown docs](https://bun.com/docs/runtime/markdown) (covers `html`, `render`, `react` only), [API reference](https://bun.com/reference/bun/markdown) (all four functions), [v1.3.8 blog](https://bun.com/blog/bun-v1.3.8) (introduction), and [v1.3.12 blog](https://bun.com/blog/bun-v1.3.12) (`ansi()` + `bun ./file.md` CLI).
>
> **Version history:** `html`/`render`/`react` introduced v1.3.8 · `ansi()` + `bun ./file.md` CLI added v1.3.12 · v1.3.14 fixed `ansi()` crash on invalid UTF-8 (lone continuation bytes `0x80-0xBF`, bytes `0xF8-0xFF` now treated as replacement characters).

### Four Render Functions

| Function | Signature | Returns | Use Case |
|----------|-----------|---------|----------|
| `Bun.markdown.html()` | `html(input, options?)` | `string` | Render to HTML string |
| `Bun.markdown.render()` | `render(input, callbacks?, options?)` | `string` | Custom callbacks per element (ANSI, custom HTML, plain text) |
| `Bun.markdown.react()` | `react(input, components?, options?)` | `unknown` (React Fragment) | React JSX elements; SSR via `renderToString()` |
| `Bun.markdown.ansi()` | `ansi(input, theme?)` | `string` | ANSI-colored terminal output; enables all GFM + wikilinks + underline + LaTeX math by default. **v1.3.12+** |

**Input type:** `string | ArrayBufferLike | TypedArray | DataView`

**CLI:** `bun ./file.md` (v1.3.12+) — renders a Markdown file directly to formatted ANSI terminal output with zero JS VM startup overhead. Uses `ansi()` internally.

```ts
// html() — simplest
const html = Bun.markdown.html("# Hello **world**");
// "<h1>Hello <strong>world</strong></h1>\n"

// render() — custom callbacks (ANSI example)
const ansi = Bun.markdown.render("# Hello\n\n**bold**", {
  heading: (children) => `\x1b[1;4m${children}\x1b[0m\n`,
  paragraph: (children) => children + "\n",
  strong: (children) => `\x1b[1m${children}\x1b[22m`,
});

// react() — React component
function Markdown({ text }: { text: string }) {
  return Bun.markdown.react(text);
}
// SSR
import { renderToString } from "react-dom/server";
const html = renderToString(Bun.markdown.react("# Hello **world**"));

// ansi() — terminal output with theme
const out = Bun.markdown.ansi("# Hello\n\n**bold** and *italic*\n");
process.stdout.write(out);
// Plain text (no escape codes)
const plain = Bun.markdown.ansi("# Hello", { colors: false });
// OSC 8 clickable hyperlinks
const linked = Bun.markdown.ansi("[docs](https://bun.com)", { hyperlinks: true });
```

### Options (Parser Configuration)

`html`, `render`, and `react` accept `Options` (html: 2nd arg; render: 3rd arg; react: 3rd arg as `ReactOptions`). `ansi()` uses `AnsiTheme` instead (see [AnsiTheme](#ansitheme-ansi-second-argument) below).

**GFM extensions — enabled by default:**

| Option | Default | Description |
|--------|---------|-------------|
| `tables` | `true` | GFM tables |
| `strikethrough` | `true` | GFM strikethrough (`~~text~~`) |
| `tasklists` | `true` | GFM task lists (`- [x] item`) |

**Additional options — all default `false`:**

| Option | Type | Description |
|--------|------|-------------|
| `autolinks` | `boolean \| { url: boolean, www: boolean, email: boolean }` | Autolink URLs, emails, www links. `true` = all types |
| `headings` | `boolean \| { ids: boolean, autolink: boolean }` | Heading IDs and autolink headings. `true` = both |
| `hardSoftBreaks` | `boolean` | Treat soft line breaks as hard breaks (`<br>`) |
| `wikiLinks` | `boolean` | Enable `[[wiki links]]` and `[[target\|label]]` |
| `underline` | `boolean` | `__text__` renders as `<u>` instead of `<strong>` |
| `latexMath` | `boolean` | Enable `$inline$` and `$$display$$` math |
| `collapseWhitespace` | `boolean` | Collapse whitespace in text content |
| `permissiveAtxHeaders` | `boolean` | ATX headers without space after `#` |
| `noIndentedCodeBlocks` | `boolean` | Disable indented code blocks |
| `noHtmlBlocks` | `boolean` | Disable HTML blocks |
| `noHtmlSpans` | `boolean` | Disable inline HTML spans |
| `tagFilter` | `boolean` | GFM tag filter — replaces `<` with `&lt;` for disallowed HTML tags (`<script>`, `<style>`, `<iframe>`) |

#### Autolinks (detailed)

```ts
// Enable all autolink types (URL, WWW, email)
Bun.markdown.html("Visit www.example.com or email test@example.com", {
  autolinks: true,
});

// Granular control — only URL and www
Bun.markdown.html("Visit www.example.com", {
  autolinks: { url: true, www: true }, // email: false (default)
});
```

#### Heading IDs (detailed)

```ts
// Enable both heading IDs and autolink headings
Bun.markdown.html("## Hello World", { headings: true });
// '<h2 id="hello-world"><a href="#hello-world">Hello World</a></h2>\n'

// Enable only heading IDs (no autolink)
Bun.markdown.html("## Hello World", { headings: { ids: true } });
// '<h2 id="hello-world">Hello World</h2>\n'
```

### Meta Interfaces (passed to `render()` callbacks)

Each callback receives `(children: string, meta?: MetaInterface)`. Return `string` to replace output, `null`/`undefined` to omit element.

| Interface | Fields | Used by callback |
|-----------|--------|-----------------|
| `ListMeta` | `depth: number`, `ordered: boolean`, `start?: number` | `list` |
| `ListItemMeta` | `index: number`, `depth: number`, `ordered: boolean`, `start?: number`, `checked?: boolean` | `listItem` |
| `HeadingMeta` | `level: number` (1–6), `id?: string` | `heading` |
| `CodeBlockMeta` | `language?: string` | `code` |
| `CellMeta` | `align?: 'left' \| 'center' \| 'right'` | `th`, `td` |
| `LinkMeta` | `href: string`, `title?: string` | `link` |
| `ImageMeta` | `src: string`, `title?: string` | `image` |

### Render Callbacks (`render()` second argument)

Return `string` to replace output, `null`/`undefined` to omit element. If no callback is registered, children pass through unchanged. **21 callbacks total** (14 block + 7 inline).

**Block callbacks:**

| Callback | Meta | Description |
|----------|------|-------------|
| `heading` | `HeadingMeta` `{ level, id? }` | Heading level 1–6. `id` set when `headings: { ids: true }`. |
| `paragraph` | — | Paragraph block |
| `blockquote` | — | Blockquote block |
| `code` | `CodeBlockMeta` `{ language? }` | Fenced/indented code block. `language` is info-string (e.g. `"js"`). Only passed for fenced code blocks with a language. |
| `list` | `ListMeta` `{ ordered, start?, depth }` | Ordered or unordered list. `start` is first item number for ordered lists. |
| `listItem` | `ListItemMeta` `{ index, depth, ordered, start?, checked? }` | List item. `meta` always includes `{index, depth, ordered}`. `start` set for ordered lists; `checked` set for task list items. |
| `hr` | — | Horizontal rule |
| `table` | — | Table block |
| `thead` | — | Table head |
| `tbody` | — | Table body |
| `tr` | — | Table row |
| `th` | `CellMeta` `{ align? }` | Table header cell. `align` is `"left"`, `"center"`, `"right"`, or absent. |
| `td` | `CellMeta` `{ align? }` | Table data cell. `align` set when column alignment specified. |
| `html` | — | Raw HTML content |

**Inline callbacks:**

| Callback | Meta | Description |
|----------|------|-------------|
| `strong` | — | Strong emphasis (`**text**`) |
| `emphasis` | — | Emphasis (`*text*`) |
| `strikethrough` | — | Strikethrough (`~~text~~`) |
| `link` | `LinkMeta` `{ href, title? }` | Link. `href` is URL, `title` is optional title attribute. |
| `image` | `ImageMeta` `{ src, title? }` | Image. `src` is URL, `title` is optional title attribute. |
| `codespan` | — | Inline code (`` `code` ``) |
| `text` | — | Plain text content. **Note:** receives `text` directly (not `children`). |

#### List item meta (detailed)

The `listItem` callback receives everything needed to render markers directly — no post-processing:
- `index` — 0-based position within the parent list
- `depth` — the parent list's nesting level (0 = top-level)
- `ordered` — whether the parent list is ordered
- `start` — the parent list's start number (only when `ordered` is true)
- `checked` — task list state (only for `- [x]` / `- [ ]` items)

#### Examples

```ts
// render() with parser options as third argument
const linked = Bun.markdown.render("Visit www.example.com", {
  link: (children, { href }) => `[${children}](${href})`,
  paragraph: (children) => children,
}, { autolinks: true });

// Stripping all formatting (plain text extraction)
const plaintext = Bun.markdown.render("# Hello **world**", {
  heading: children => children,
  paragraph: children => children,
  strong: children => children,
  emphasis: children => children,
  link: children => children,
  image: () => "",
  code: children => children,
  codespan: children => children,
});
// "Hello world"

// Omitting elements (return null/undefined to remove)
const omitted = Bun.markdown.render("# Title\n\n![logo](img.png)\n\nHello", {
  image: () => null, // Remove all images
  heading: children => children,
  paragraph: children => children + "\n",
});
// "Title\nHello\n"

// Nested list numbering — listItem meta gives everything needed
// (toRoman is a user-supplied helper, e.g. 4 → "iv")
const nested = Bun.markdown.render("1. first\n   1. sub-a\n   2. sub-b\n2. second", {
  listItem: (children, { index, depth, ordered, start }) => {
    const n = (start ?? 1) + index;
    const marker = !ordered
      ? "-"
      : depth === 0
        ? `${n}.`
        : depth === 1
          ? `${String.fromCharCode(96 + n)}.`
          : `${toRoman(n)}.`;
    return "  ".repeat(depth) + marker + " " + children.trimEnd() + "\n";
  },
  list: children => "\n" + children, // prepend newline for nested list separation
});
// 1. first
//   a. sub-a
//   b. sub-b
// 2. second

// Code block syntax highlighting
const highlighted = Bun.markdown.render("```js\nconsole.log('hi')\n```", {
  code: (children, meta) => {
    const lang = meta?.language ?? "";
    return `<pre><code class="language-${lang}">${children}</code></pre>`;
  },
});
```

### React Component Overrides (`react()` second argument)

Every HTML tag can be overridden with a custom React component:

| Override | Props | Description |
|----------|-------|-------------|
| `h1`–`h6` | `{ id?, children }` | Headings (`id` when `headings: { ids: true }`) |
| `p` | `{ children }` | Paragraph |
| `blockquote` | `{ children }` | Blockquote |
| `pre` | `{ language?, children }` | Code block |
| `hr` | `{}` | Horizontal rule (no children) |
| `ul` | `{ children }` | Unordered list |
| `ol` | `{ start, children }` | Ordered list |
| `li` | `{ checked?, children }` | List item (`checked` for task lists) |
| `table`/`thead`/`tbody`/`tr` | `{ children }` | Table elements |
| `th`/`td` | `{ align?, children }` | Table cells |
| `em`/`strong`/`del`/`u` | `{ children }` | Inline styles |
| `a` | `{ href, title?, children }` | Link |
| `img` | `{ src, alt?, title? }` | Image (no children) |
| `code` | `{ children }` | Inline code |
| `br` | `{}` | Line break |
| `html` | `{ children }` | Raw HTML |
| `math` | `{ children }` | LaTeX math |

```ts
function Code({ language, children }: { language?: string; children: React.ReactNode }) {
  return <pre data-language={language}><code>{children}</code></pre>;
}
function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank">{children}</a>;
}
const el = Bun.markdown.react(text, { pre: Code, a: Link }, { headings: { ids: true } });

// React 18 compatibility
const el18 = Bun.markdown.react(text, undefined, { reactVersion: 18 });
```

### AnsiTheme (`ansi()` second argument)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `colors` | `boolean` | `true` | Emit ANSI color + styling escape sequences. `false` = plain ASCII (no box drawing, no emoji, no escape codes) |
| `columns` | `number` | `auto` | Line width for word-wrapping paragraphs/headings/HR. `0` = disable wrapping |
| `hyperlinks` | `boolean` | `false` | Emit OSC 8 hyperlinks (clickable in modern terminals). `false` = `text (url)` |
| `kittyGraphics` | `boolean` | `false` | Inline images via Kitty Graphics Protocol (Kitty, WezTerm, Ghostty). Falls through to text alt for remote URLs |
| `light` | `boolean` | `auto` | Terminal background is light. Affects inline code background color. Auto-detected from `COLORFGBG` env var |

### ReactOptions (`react()` third argument)

Same as `Options` plus:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `reactVersion` | `18 \| 19` | `19` | Which `$$typeof` symbol to use. `19` = `Symbol.for('react.transitional.element')`; `18` = `Symbol.for('react.element')` (for React 18 and older) |

---

## Explanation of Key Integrations

| Integration Point | Bun APIs Used |
|-------------------|---------------|
| **Build & Tooling** | `--define`, `bun build --compile`, TypeScript with `@types/bun` |
| **Main Server** | `Bun.serve`, `Bun.CookieMap`, `Bun.CSRF`, `Bun.password`, `Bun.cron` (in-process) |
| **Workers** | `Bun.spawn` (IPC, `--no-orphans`), `process.execve` (optional), `Bun.WebView`, `Bun.Image`, `Bun.color` |
| **Scheduling** | `Bun.cron` (in-process & OS-level) |
| **Security** | `Bun.CSRF`, `Bun.CookieMap`, `Bun.password`, `Bun.secrets`, rate limiting, CORS |
| **Observability** | `console.log` with `%j`, `/metrics` endpoint, health checks |
| **Networking** | `fetch()` (HTTP/3), shared SSL_CTX, `perMessageDeflate: false` |
| **File System** | `fs.watch` (rewritten), `Bun.write`, `Bun.file`, `bun:sqlite` |
| **Live Control** | `Bun.serve` WebSocket, `Bun.Terminal` (Windows ConPTY) |
| **Markdown Rendering** | `Bun.markdown` (`html`, `render`, `react`, `ansi`) — dashboard logs, task descriptions, reports, terminal CLI |

---

## Version Mapping Summary

| Major Release | APIs Introduced / Updated |
|---------------|---------------------------|
| v1.1.30 | `Bun.color` |
| v1.2.7 | `Bun.CookieMap` |
| v1.3.4 | `console.log` `%j`, standalone config skip, `http.Agent` keepAlive fix |
| v1.3.8 | `Bun.markdown` (`html`, `render`, `react`) |
| v1.3.11 | `Bun.cron` |
| v1.3.12 | `Bun.WebView`, `Bun.markdown.ansi()`, `bun ./file.md` CLI |
| v1.3.14 | `Bun.Image`, `process.execve`, `Bun.Terminal` (Windows), HTTP/3, shared SSL_CTX, `fs.watch` rewrite, `perMessageDeflate: false`, `SIGHUP`/`SIGBREAK` on Windows, native `using`, `--no-orphans`, FreeBSD/Android, `Bun.markdown.ansi()` UTF-8 fix |

---

This table serves as the **single source of truth** for all Bun-specific APIs in the platform, with direct links to the relevant blogs and docs.
