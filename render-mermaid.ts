#!/usr/bin/env bun
/**
 * Render a Mermaid (.mmd) diagram to SVG/PNG/PDF using mermaid-cli,
 * with the headless browser path and brand color palette resolved from
 * Bun env vars.
 *
 * Env vars (loaded automatically from .env by Bun):
 *   MERMAID_BROWSER_PATH   Path to a Chromium-based browser binary.
 *   MERMAID_THEME          default | forest | dark | neutral
 *   MERMAID_FORMAT         svg | png | pdf
 *   MERMAID_OUTPUT_DIR     Output directory (default: cwd)
 *
 *   BRAND_COLOR_LABEL      Terminal label color (any CSS color)
 *   BRAND_COLOR_VALUE      Terminal value color
 *   BRAND_COLOR_OK         Success color
 *   BRAND_COLOR_ERR        Error color
 *   BRAND_COLOR_WARN       Warning color
 *   BRAND_COLOR_BG         Canvas background color (passed to mermaid-cli -b)
 *
 * All BRAND_COLOR_* values are validated and normalized via Bun.color at
 * startup. Invalid values abort with a clear error before any render.
 *
 * Usage:
 *   bun run render-mermaid.ts <input.mmd> [output.<svg|png|pdf>]
 *   bun run render-mermaid.ts deepseek_mermaid_20260814_ef065a.mmd
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { color, write } from "bun";

// --- Brand color palette (env → Bun.color) ---------------------------------
// Each BRAND_COLOR_* env var is parsed once at startup. Terminal output uses
// the "ansi" format (auto-detects terminal color depth); the canvas background
// uses "hex" for mermaid-cli's -b flag. Invalid colors abort early.
const RESET = "\x1b[0m";

type ColorRole = "label" | "value" | "ok" | "err" | "warn";
const ROLE_ENV: Record<ColorRole, string> = {
  label: "BRAND_COLOR_LABEL",
  value: "BRAND_COLOR_VALUE",
  ok: "BRAND_COLOR_OK",
  err: "BRAND_COLOR_ERR",
  warn: "BRAND_COLOR_WARN",
};

function loadBrandColor(role: ColorRole): string {
  const envName = ROLE_ENV[role];
  const raw = process.env[envName]?.trim();
  if (!raw) {
    console.error(`${envName} is not set. Define it in .env.`);
    process.exit(1);
  }
  // Validate the *input* with "hex" — it always returns a string or null,
  // regardless of terminal color capability. "ansi" returns empty string
  // when NO_COLOR=1 or stdout lacks color support, which would pass a
  // null-check but tell us nothing about whether the input parsed.
  const hex = color(raw, "hex");
  if (hex === null) {
    console.error(
      `${envName}="${raw}" is not a valid CSS color. ` +
        `Examples: "#8be9fd", "rgb(139,233,253)", "hsl(193,100%,87%)".`,
    );
    process.exit(1);
  }
  // Emit ANSI for terminal output. Respects NO_COLOR / FORCE_COLOR env vars
  // automatically: returns "" when color is disabled, escape string otherwise.
  return color(raw, "ansi") ?? "";
}

const ansi: Record<ColorRole, string> = {
  label: loadBrandColor("label"),
  value: loadBrandColor("value"),
  ok: loadBrandColor("ok"),
  err: loadBrandColor("err"),
  warn: loadBrandColor("warn"),
};

// Wrap text with the role's ANSI color + reset. When color is disabled
// (NO_COLOR=1, non-TTY stdout), the ansi value is "" and we skip RESET too —
// no escape codes in production logs.
const wrap = (prefix: string, s: string) =>
  prefix ? `${prefix}${s}${RESET}` : s;

const c = {
  label: (s: string) => wrap(ansi.label, s),
  value: (s: string) => wrap(ansi.value, s),
  ok: (s: string) => wrap(ansi.ok, s),
  err: (s: string) => wrap(ansi.err, s),
  warn: (s: string) => wrap(ansi.warn, s),
};

// Canvas background — normalized to hex for mermaid-cli's -b flag.
const bgRaw = process.env.BRAND_COLOR_BG?.trim();
let bgHex: string | null = null;
if (bgRaw) {
  bgHex = color(bgRaw, "hex");
  if (bgHex === null) {
    console.error(
      `${c.err("error:")} BRAND_COLOR_BG="${bgRaw}" is not a valid CSS color. ` +
        `Examples: "#1f2020", "rgb(31,32,32)", "hsl(180,2%,12%)".`,
    );
    process.exit(1);
  }
}

// --- TempDir disposable ----------------------------------------------------
// A temp directory that implements Disposable (Symbol.dispose), so it can be
// used with `using` for automatic recursive cleanup when the block or script
// exits — including on thrown errors. Leverages Bun v1.3.14's native `using`
// support (no transpilation when target=bun).
//
// SIGKILL bypasses dispose (the kernel terminates the process immediately),
// so stale dirs from crashed runs are swept at startup by the age-threshold
// check below — concurrent renders are safe because we only sweep dirs older
// than 1 hour.
const TMP_PREFIX = "mermaid-chrome-";
const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

class TempDir implements Disposable {
  readonly path: string;

  constructor() {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.path = join(tmpdir(), `${TMP_PREFIX}${id}`);
    mkdirSync(this.path, { recursive: true });
  }

  [Symbol.dispose]() {
    try {
      rmSync(this.path, { recursive: true, force: true });
    } catch {
      // Already removed or in use — nothing to do.
    }
  }
}

// Sweep stale temp dirs (older than 1 hour) from previous crashed runs.
// This avoids deleting temp dirs belonging to concurrent render processes.
const tmpRoot = tmpdir();
const sweepNow = Date.now();
for (const entry of readdirSync(tmpRoot)) {
  if (!entry.startsWith(TMP_PREFIX)) continue;
  const dirPath = join(tmpRoot, entry);
  try {
    const stat = statSync(dirPath);
    if (sweepNow - stat.mtimeMs < STALE_THRESHOLD_MS) continue; // Too recent — maybe in use.
    rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // In use or already gone — skip.
  }
}

// --- Render ----------------------------------------------------------------
const inputArg = process.argv[2];
if (!inputArg) {
  console.error(
    `${c.err("error:")} usage: bun run render-mermaid.ts <input.mmd | URL> [output]`,
  );
  process.exit(1);
}

// Input can be a local file path or a URL. When it's a URL, fetch the .mmd
// content and write it to a temp file. HTTP/3 is used automatically when the
// server supports it (Bun negotiates via QUIC); for HTTP/2-only servers, Bun
// falls back to HTTP/1.1 over TLS. The { protocol: "http3" } hint tells
// Bun's fetch to prefer QUIC when available.
const isUrl = inputArg.startsWith("http://") || inputArg.startsWith("https://");
let input: string;
let fetchedTempPath: string | null = null;

if (isUrl) {
  console.log(`${c.label("fetch:")} ${c.value(inputArg)}`);
  // In dev, self-signed certs are common. NODE_TLS_REJECT_UNAUTHORIZED=0
  // disables cert verification globally; we also pass tls config per-request.
  const tlsOpts = process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
    ? { tls: { rejectUnauthorized: false } }
    : {};
  // Try HTTP/3 first (QUIC — lower latency, multiplexed). If the server
  // doesn't support it, fall back to default. The fallback fetch will
  // auto-negotiate HTTP/2 via ALPN if BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT=1
  // is set (or --experimental-http2-fetch CLI flag), otherwise HTTP/1.1.
  //
  // Ref: https://bun.sh/blog/bun-v1.3.14#experimental-http-3-client-for-fetch
  // Bun 1.3.14 added `protocol: "http3"` (also "h3") to fetch() as an
  // experimental feature. The bun-types .d.ts in this install haven't been
  // updated to include "http3" in the protocol union yet, so we cast.
  let content: string;
  try {
    // JUSTIFIED: bun-types globals.d.ts only types protocol as "http2"|"http1.1"|"h2"|"h1"
    // but Bun 1.3.14 added "http3"|"h3" per the v1.3.14 blog post. The cast
    // bridges the gap until bun-types ships the updated union.
    const res = await fetch(inputArg, { protocol: "http3", ...tlsOpts } as any);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    content = await res.text();
    console.log(`  ${c.ok("h3")} ${content.length} bytes`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ${c.warn("retry:")} HTTP/3 unavailable (${msg}), using default`);
    // JUSTIFIED: tlsOpts shape is BunFetchRequestInit["tls"] which is valid for
    // fetch() but not in the standard RequestInit type. Same gap as above.
    const res = await fetch(inputArg, tlsOpts as any);
    if (!res.ok) {
      console.error(`${c.err("error:")} fetch failed: ${res.status} ${res.statusText}`);
      process.exit(1);
    }
    content = await res.text();
    console.log(`  ${c.ok("fetched")} ${content.length} bytes`);
  }
  fetchedTempPath = join(tmpdir(), `mermaid-input-${Date.now()}.mmd`);
  await write(fetchedTempPath, content);
  input = fetchedTempPath;
} else {
  input = inputArg;
  if (!existsSync(input)) {
    console.error(
      `${c.err("error:")} input file not found: ${input}`,
    );
    process.exit(1);
  }
}

const browserPath = process.env.MERMAID_BROWSER_PATH;
const theme = process.env.MERMAID_THEME ?? "default";
const format = process.env.MERMAID_FORMAT ?? "svg";
const outDir = resolve(process.env.MERMAID_OUTPUT_DIR ?? ".");

if (!browserPath || !existsSync(browserPath)) {
  console.error(
    `${c.err("error:")} MERMAID_BROWSER_PATH is missing or invalid: ` +
      `"${browserPath}". Set it in .env to a Chromium-based browser binary.`,
  );
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const explicitOut = process.argv[3];
// For URL inputs, derive the output name from the URL's path, not the temp
// file name. E.g., https://example.com/diagram.mmd → diagram.svg
const baseName = isUrl
  ? basename(new URL(inputArg).pathname, extname(new URL(inputArg).pathname)) || "diagram"
  : basename(input, extname(input));
const outName = explicitOut ? explicitOut : baseName + "." + format;
const outPath = join(outDir, outName);

// --- Temp dir + render -----------------------------------------------------
// `using` ensures the temp dir is cleaned up when this block exits — whether
// by normal completion, a thrown error, or process.exit() called inside the
// block. The dispose runs before the process fully terminates.
// Isolated Chrome user-data-dir — critical when the user's Chrome is already
// running. Without this, puppeteer launches Chrome with the same binary, but
// Chrome's SingletonLock (held by the running instance) prevents a second
// instance from using the same profile directory, causing mmdc to hang
// indefinitely. A throwaway temp dir sidesteps the lock entirely.
using tempDir = new TempDir();
const puppeteerConfigPath = join(tempDir.path, "puppeteer-config.json");
await write(
  puppeteerConfigPath,
  JSON.stringify(
    {
      executablePath: browserPath,
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-gpu",
        `--user-data-dir=${tempDir.path}`,
      ],
    },
    null,
    2,
  ),
);

console.log(`${c.label("render:")} ${c.value(input)}`);
console.log(`  ${c.label("browser:")} ${c.value(browserPath)}`);
console.log(`  ${c.label("theme:")}   ${c.value(theme)}`);
console.log(`  ${c.label("format:")}  ${c.value(format)}`);
console.log(`  ${c.label("bg:")}      ${bgHex ? c.value(bgHex) : c.warn("(default)")}`);
console.log(`  ${c.label("output:")}  ${c.value(outPath)}`);

// --- Launch mermaid-cli via Bun.spawn (inherited stdio) ---------------------
// Run mermaid-cli's entry point directly with `bun`, bypassing the
// `#!/usr/bin/env node` shebang to force Bun's runtime for mmdc.
//
// Why Bun.spawn with inherited stdio instead of `$` template or process.execve:
//
//   `$` template: pipes stdout/stderr through Bun Shell's internal buffers.
//   mmdc/puppeteer deadlocks waiting on stdio buffers the parent isn't draining
//   fast enough — the nested-Bun hang.
//
//   process.execve: replaces the process image (no child, no pipe), but never
//   returns — so we can't run a watchdog to kill mmdc when it hangs *after*
//   writing the SVG.
//
//   Bun.spawn({ stdio: "inherit" }): the child writes directly to the real
//   terminal (no pipe deadlock), AND we can await proc.exited + kill on
//   timeout. Best of both worlds.
//
// ROOT CAUSE of the post-render hang: BUN_OPTIONS=--hot (from .env.development)
// is inherited by the child `bun mmdc` process. --hot keeps Bun's event loop
// alive after the script finishes (hot module reloading watches for changes),
// so mmdc writes the SVG but never exits. We strip BUN_OPTIONS from the child
// env so mmdc's Bun runtime exits cleanly when the script ends.
const mmdcEntry = resolve("node_modules/@mermaid-js/mermaid-cli/src/cli.js");
if (!existsSync(mmdcEntry)) {
  console.error(
    `${c.err("error:")} @mermaid-js/mermaid-cli not installed. Run: bun add -d @mermaid-js/mermaid-cli`,
  );
  process.exit(1);
}

const bgFlag = bgHex ? ["-b", bgHex] : [];
console.log(`  ${c.label("bgFlag:")} ${c.value(JSON.stringify(bgFlag))}`);

// Build a clean env for the child: strip BUN_OPTIONS (--hot keeps the event
// loop alive) and BUN_CONFIG_VERBOSE_FETCH (noisy puppeteer fetch logs).
const childEnv = { ...process.env };
delete childEnv.BUN_OPTIONS;
delete childEnv.BUN_CONFIG_VERBOSE_FETCH;

// Watchdog: mmdc renders in ~3-5s. If the process hasn't exited after the
// timeout, it's hung — kill it. The SVG is usually already written by that
// point. Configurable via MERMAID_TIMEOUT_MS env var (default 15s).
const WATCHDOG_MS = parseInt(process.env.MERMAID_TIMEOUT_MS ?? "15000", 10);
// Use process.execPath (the current Bun binary) instead of a hardcoded "bun"
// — works regardless of how Bun was invoked or if it's not on PATH.
const proc = Bun.spawn({
  cmd: [
    process.execPath,
    mmdcEntry,
    "-i",
    input,
    "-o",
    outPath,
    "-t",
    theme,
    "-e",
    format,
    "-p",
    puppeteerConfigPath,
    ...bgFlag,
  ],
  cwd: process.cwd(),
  env: childEnv,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

let killed = false;
const watchdog = setTimeout(() => {
  killed = true;
  console.error(`${c.warn("watchdog:")} mmdc didn't exit after ${WATCHDOG_MS}ms — killing`);
  try {
    process.kill(proc.pid, "SIGKILL");
  } catch {
    // Already dead.
  }
}, WATCHDOG_MS);

const exitCode = await proc.exited;
clearTimeout(watchdog);

// Clean up fetched temp file if input was a URL.
if (fetchedTempPath) {
  try { rmSync(fetchedTempPath, { force: true }); } catch {}
}

if (killed) {
  // The SVG may still be valid even if we had to kill mmdc — check.
  if (existsSync(outPath)) {
    console.log(`${c.warn("done:")} ${c.value(outPath)} ${c.warn("(mmdc killed by watchdog, output may be valid)")}`);
    process.exit(0);
  }
  console.error(`${c.err("error:")} mmdc killed by watchdog, no output produced`);
  process.exit(124);
}

if (exitCode !== 0) {
  console.error(`${c.err("error:")} mermaid-cli exited with code ${exitCode}`);
  process.exit(exitCode);
}

console.log(`${c.ok("done:")} ${c.value(outPath)}`);
