#!/usr/bin/env bun
/**
 * Render a Mermaid (.mmd) diagram to SVG or PNG using Bun.WebView.
 *
 * Loads mermaid.js inside a headless browser view, calls mermaid.render(),
 * and extracts the SVG via evaluate() or captures a PNG via screenshot().
 *
 * No puppeteer, no mermaid-cli — just Bun.WebView + mermaid.js.
 *
 * Env vars (loaded automatically from .env by Bun):
 *   MERMAID_THEME          default | forest | dark | neutral
 *   MERMAID_FORMAT         svg | png
 *   MERMAID_OUTPUT_DIR     Output directory (default: cwd)
 *   MERMAID_TIMEOUT_MS     Watchdog timeout for hung renders (ms). Default: 15000
 *
 *   BRAND_COLOR_LABEL      Terminal label color (any CSS color)
 *   BRAND_COLOR_VALUE      Terminal value color
 *   BRAND_COLOR_OK         Success color
 *   BRAND_COLOR_ERR        Error color
 *   BRAND_COLOR_WARN       Warning color
 *   BRAND_COLOR_BG         Canvas background color (passed as CSS background)
 *
 * Usage:
 *   bun run render-mermaid.ts <input.mmd> [output.<svg|png>]
 *   bun run render-mermaid.ts deepseek_mermaid_20260814_ef065a.mmd
 */

import { existsSync, mkdirSync, rmSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { color, write } from "bun";

// --- Brand color palette (env → Bun.color) ---------------------------------
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
  const hex = color(raw, "hex");
  if (hex === null) {
    console.error(
      `${envName}="${raw}" is not a valid CSS color. ` +
        `Examples: "#8be9fd", "rgb(139,233,253)", "hsl(193,100%,87%)".`,
    );
    process.exit(1);
  }
  return color(raw, "ansi") ?? "";
}

const ansi: Record<ColorRole, string> = {
  label: loadBrandColor("label"),
  value: loadBrandColor("value"),
  ok: loadBrandColor("ok"),
  err: loadBrandColor("err"),
  warn: loadBrandColor("warn"),
};

const wrap = (prefix: string, s: string) =>
  prefix ? `${prefix}${s}${RESET}` : s;

const c = {
  label: (s: string) => wrap(ansi.label, s),
  value: (s: string) => wrap(ansi.value, s),
  ok: (s: string) => wrap(ansi.ok, s),
  err: (s: string) => wrap(ansi.err, s),
  warn: (s: string) => wrap(ansi.warn, s),
};

// Canvas background — normalized to hex for CSS.
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

// --- Input handling --------------------------------------------------------
const inputArg = process.argv[2];
if (!inputArg) {
  console.error(
    `${c.err("error:")} usage: bun run render-mermaid.ts <input.mmd | URL> [output]`,
  );
  process.exit(1);
}

const isUrl = inputArg.startsWith("http://") || inputArg.startsWith("https://");
let mermaidDefinition: string;
let baseName: string;

if (isUrl) {
  console.log(`${c.label("fetch:")} ${c.value(inputArg)}`);
  // JUSTIFIED: bun-types globals.d.ts only types protocol as "http2"|"http1.1"|"h2"|"h1"
  // but Bun 1.3.14 added "http3"|"h3" per the v1.3.14 blog post. The cast
  // bridges the gap until bun-types ships the updated union.
  // Ref: https://bun.sh/blog/bun-v1.3.14#experimental-http-3-client-for-fetch
  const tlsOpts = process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
    ? { tls: { rejectUnauthorized: false } }
    : {};
  let content: string;
  try {
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
  mermaidDefinition = content;
  const urlPath = new URL(inputArg).pathname;
  baseName = basename(urlPath, extname(urlPath)) || "diagram";
} else {
  if (!existsSync(inputArg)) {
    console.error(`${c.err("error:")} input file not found: ${inputArg}`);
    process.exit(1);
  }
  mermaidDefinition = await Bun.file(inputArg).text();
  baseName = basename(inputArg, extname(inputArg));
}

// --- Config ----------------------------------------------------------------
const theme = process.env.MERMAID_THEME ?? "default";
const format = process.env.MERMAID_FORMAT ?? "svg";
const outDir = resolve(process.env.MERMAID_OUTPUT_DIR ?? ".");
const WATCHDOG_MS = parseInt(process.env.MERMAID_TIMEOUT_MS ?? "15000", 10);

mkdirSync(outDir, { recursive: true });

const explicitOut = process.argv[3];
const outName = explicitOut ?? `${baseName}.${format}`;
const outPath = join(outDir, outName);

if (format !== "svg" && format !== "png") {
  console.error(`${c.err("error:")} format must be "svg" or "png" (got "${format}")`);
  console.error(`  PDF is not supported with Bun.WebView. Use SVG and convert separately.`);
  process.exit(1);
}

// --- Verify mermaid modules exist ------------------------------------------
const nodeModulesRoot = resolve(import.meta.dir, "node_modules");
const mermaidDir = join(nodeModulesRoot, "mermaid", "dist");
const elkDir = join(nodeModulesRoot, "@mermaid-js", "layout-elk", "dist");
const zenumlDir = join(nodeModulesRoot, "@mermaid-js", "mermaid-zenuml", "dist");
const tidyTreeDir = join(nodeModulesRoot, "@mermaid-js", "layout-tidy-tree", "dist");

for (const [label, p] of [
  ["mermaid", join(mermaidDir, "mermaid.esm.mjs")],
  ["layout-elk", join(elkDir, "mermaid-layout-elk.esm.mjs")],
  ["mermaid-zenuml", join(zenumlDir, "mermaid-zenuml.esm.mjs")],
  ["layout-tidy-tree", join(tidyTreeDir, "mermaid-layout-tidy-tree.esm.mjs")],
] as const) {
  if (!existsSync(p)) {
    console.error(`${c.err("error:")} ${label} module not found at ${p}`);
    console.error(`  Run: bun install`);
    process.exit(1);
  }
}

// --- Local module server ---------------------------------------------------
// Bun.WebView can't load ESM modules via file:// URLs (the browser's CSP
// blocks file:// module imports). We serve the mermaid dist directories
// via a temporary local HTTP server so the page can import them via
// http://localhost:PORT/mermaid/mermaid.esm.mjs etc.
//
// The server is stopped after rendering completes.

const moduleServer = Bun.serve({
  port: 0, // let the OS pick a free port
  fetch(req) {
    const url = new URL(req.url);
    // Map /mermaid/* → node_modules/mermaid/dist/*
    // Map /@mermaid-js/layout-elk/* → node_modules/@mermaid-js/layout-elk/dist/*
    // etc.
    const path = url.pathname;
    let fsPath: string | null = null;

    if (path.startsWith("/mermaid/")) {
      fsPath = join(mermaidDir, path.slice("/mermaid/".length));
    } else if (path.startsWith("/layout-elk/")) {
      fsPath = join(elkDir, path.slice("/layout-elk/".length));
    } else if (path.startsWith("/mermaid-zenuml/")) {
      fsPath = join(zenumlDir, path.slice("/mermaid-zenuml/".length));
    } else if (path.startsWith("/layout-tidy-tree/")) {
      fsPath = join(tidyTreeDir, path.slice("/layout-tidy-tree/".length));
    }

    if (!fsPath) {
      return new Response("not found", { status: 404 });
    }

    // Prevent path traversal outside the dist directories
    const resolved = resolve(fsPath);
    const allowedRoots = [mermaidDir, elkDir, zenumlDir, tidyTreeDir];
    if (!allowedRoots.some((root) => resolved.startsWith(root + "/") || resolved === root)) {
      return new Response("forbidden", { status: 403 });
    }

    const file = Bun.file(resolved);
    if (!file.exists()) {
      return new Response("not found", { status: 404 });
    }

    // Set correct Content-Type for .mjs files
    const headers: Record<string, string> = {
      "Content-Type": "application/javascript",
      "Access-Control-Allow-Origin": "*",
    };
    return new Response(file, { headers });
  },
});

const modulePort = moduleServer.port;
const moduleBase = `http://localhost:${modulePort}`;

console.log(`${c.label("render:")} ${c.value(inputArg)}`);
console.log(`  ${c.label("theme:")}   ${c.value(theme)}`);
console.log(`  ${c.label("format:")}  ${c.value(format)}`);
console.log(`  ${c.label("bg:")}      ${bgHex ? c.value(bgHex) : c.warn("(default)")}`);
console.log(`  ${c.label("output:")}  ${c.value(outPath)}`);

// --- Build the HTML page ---------------------------------------------------
const encodedDef = encodeURIComponent(mermaidDefinition);
const bgColor = bgHex ?? "white";

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; padding: 0; background: ${bgColor}; }
  #container { display: inline-block; }
</style>
</head>
<body>
<div id="container"></div>
<script type="module">
  const mermaidDef = decodeURIComponent("${encodedDef}");

  const { default: mermaid } = await import("${moduleBase}/mermaid/mermaid.esm.mjs");
  const { default: elkLayouts } = await import("${moduleBase}/layout-elk/mermaid-layout-elk.esm.mjs");
  const { default: zenuml } = await import("${moduleBase}/mermaid-zenuml/mermaid-zenuml.esm.mjs");

  let tidyTree = undefined;
  try {
    const mod = await import("${moduleBase}/layout-tidy-tree/mermaid-layout-tidy-tree.esm.mjs");
    tidyTree = mod.default;
  } catch {
    // tidy-tree is optional
  }

  await mermaid.registerExternalDiagrams([zenuml]);
  mermaid.registerLayoutLoaders([...elkLayouts, ...(tidyTree ?? [])]);
  mermaid.initialize({ startOnLoad: false, theme: "${theme}" });

  const container = document.getElementById("container");
  try {
    const { svg } = await mermaid.render("mermaid-svg", mermaidDef, container);
    container.innerHTML = svg;
    globalThis.__mermaidResult = { ok: true, svg };
  } catch (err) {
    globalThis.__mermaidResult = { ok: false, error: err.message || String(err) };
  }
</script>
</body>
</html>`;

// Write the HTML to a temp file and load it via file:// URL
const tmpHtmlPath = join(tmpdir(), `mermaid-render-${Date.now()}.html`);
await write(tmpHtmlPath, html);

// --- Render with Bun.WebView -----------------------------------------------
const view = new Bun.WebView({
  width: 1920,
  height: 1080,
  url: `file://${tmpHtmlPath}`,
  console: (type, ...args) => {
    if (type === "error" || type === "warn") {
      console.error(`  ${c.warn(`page ${type}:`)} ${args.join(" ")}`);
    }
  },
});

let killed = false;
const watchdog = setTimeout(() => {
  killed = true;
  console.error(`${c.warn("watchdog:")} render didn't complete after ${WATCHDOG_MS}ms — killing`);
  try { view.close(); } catch {}
}, WATCHDOG_MS);

try {
  // Poll globalThis.__mermaidResult until mermaid.render() completes
  let result: { ok: boolean; svg?: string; error?: string } | null = null;
  const deadline = Date.now() + WATCHDOG_MS;
  while (!result && Date.now() < deadline && !killed) {
    await Bun.sleep(50);
    // JUSTIFIED: evaluate() returns Promise<unknown>; narrowing to the result shape
    result = await view.evaluate("globalThis.__mermaidResult ?? null") as typeof result;
  }

  if (killed) {
    console.error(`${c.err("error:")} render killed by watchdog, no output produced`);
    process.exit(124);
  }

  if (!result) {
    console.error(`${c.err("error:")} render timed out waiting for mermaid.render()`);
    process.exit(124);
  }

  if (!result.ok) {
    console.error(`${c.err("error:")} mermaid.render() failed: ${result.error}`);
    process.exit(1);
  }

  if (format === "svg") {
    // Extract the serialized SVG from the page
    const svgXml = await view.evaluate(
      `(() => {
        const svg = document.querySelector("svg");
        if (!svg) throw new Error("SVG element not found in page");
        return new XMLSerializer().serializeToString(svg);
      })()`,
    ) as string;

    await write(outPath, svgXml);
    console.log(`${c.ok("done:")} ${c.value(outPath)}`);
  } else {
    // PNG: screenshot the SVG bounding box
    const clip = await view.evaluate(
      `(() => {
        const svg = document.querySelector("svg");
        if (!svg) throw new Error("SVG element not found");
        const rect = svg.getBoundingClientRect();
        return {
          x: Math.floor(rect.left),
          y: Math.floor(rect.top),
          width: Math.ceil(rect.width),
          height: Math.ceil(rect.height),
        };
      })()`,
    // JUSTIFIED: evaluate() returns Promise<unknown>; narrowing to the clip shape
    ) as { x: number; y: number; width: number; height: number };

    // Resize the viewport to fit the SVG, then screenshot
    await view.resize(clip.x + clip.width, clip.y + clip.height);
    await Bun.sleep(100); // let the resize settle

    // L5: "blob" is the default encoding for view.screenshot(), so we
    // don't need to specify it explicitly.
    // Ref: node_modules/bun-types/bun.d.ts — screenshot(options?: { encoding?: "blob"; ... }): Promise<Blob>
    const pngBlob = await view.screenshot({ format: "png" });
    await write(outPath, pngBlob);
    console.log(`${c.ok("done:")} ${c.value(outPath)}`);
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`${c.err("error:")} render failed: ${msg}`);
  process.exit(1);
} finally {
  clearTimeout(watchdog);
  try { view.close(); } catch {}
  // Stop the module server
  moduleServer.stop();
  // Clean up temp HTML
  try { rmSync(tmpHtmlPath, { force: true }); } catch {}
}
