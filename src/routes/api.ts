// Bun API demo routes — mermaid, sql, image, hash, transpile, dns, fs, compress, utils, ffi, stream, redis, config, export, diagrams.
//
// Ref: https://bun.com/docs/runtime/http/routing

import type { BunRequest } from "bun";
import { read } from "../db";
import { audit } from "../db/audit";
import { log } from "../utils/log";
import { router } from "./router";
import { json, withAuth, withCsrf, withMiddleware } from "./shared";

// --- Handlers ---------------------------------------------------------------

// Mermaid live render — paste Mermaid code, get SVG via Bun.WebView
// Ref: node_modules/bun-types/docs/runtime/webview.mdx
const mermaidRenderHandler = withAuth<"/api/mermaid">(async (req: BunRequest<"/api/mermaid">): Promise<Response> => {
  // JUSTIFIED: req.json() returns unknown; narrowing to the mermaid render body
  const body = (await req.json()) as { code: string };
  if (!body.code || body.code.length > 10_000) {
    return json({ error: "code required (max 10kb)" }, 400);
  }
  try {
    // Ref: node_modules/bun-types/docs/runtime/webview.mdx
    await using view = new Bun.WebView({ width: 1200, height: 800 });
    const html = `data:text/html,<!DOCTYPE html><html><head><script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script></head><body><div class="mermaid">${body.code.replace(/</g, "&lt;")}</div><script>mermaid.initialize({startOnLoad:true});</script></body></html>`;
    await view.navigate(html);
    await Bun.sleep(500);
    // JUSTIFIED: evaluate returns unknown; narrowing to string
    const svg = (await view.evaluate("document.querySelector('svg')?.outerHTML ?? ''")) as string;
    if (!svg) {
      return json({ error: "render failed — check mermaid syntax" }, 422);
    }
    return new Response(svg, { headers: { "Content-Type": "image/svg+xml" } });
  } catch (err) {
    return json({ error: "render failed", details: String(err) }, 500);
  }
});

// Bun.redis — distributed rate limiting (optional, falls back to SQLite)
// Ref: node_modules/bun-types/docs/runtime/redis.mdx
const redisRateLimitHandler = withMiddleware<"">((req: BunRequest<"">): Response => {
  const url = new URL(req.url);
  const test = url.searchParams.get("test") === "1";
  if (!test) {
    return json({ error: "add ?test=1 to test redis connection" }, 400);
  }
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return json({ redis: "not configured", hint: "set REDIS_URL env var" }, 200);
  }
  return json({ redis: "configured", url: redisUrl.replace(/:[^@]+@/, ":***@") });
});

// Bun.streams — streaming file response for large files
// Ref: node_modules/bun-types/docs/runtime/streams.mdx
const streamFileHandler = withMiddleware<"/api/stream/:path">((req: BunRequest<"/api/stream/:path">): Response => {
  const filePath = req.params.path;
  if (filePath.includes("..") || filePath.includes("//")) {
    return json({ error: "invalid path" }, 400);
  }
  const file = Bun.file(`public/${filePath}`);
  if (!file.size || file.size === 0) {
    return json({ error: "file not found" }, 404);
  }
  return new Response(file, {
    headers: {
      "Content-Type": file.type,
      "Content-Length": file.size.toString(),
      "Cache-Control": "public, max-age=3600",
    },
  });
});

// Bun.sql — unified SQL query endpoint using tagged template literals
// Ref: node_modules/bun-types/docs/runtime/sql.mdx
const sqlQueryHandler = withAuth<"/api/sql">(async (req: BunRequest<"/api/sql">): Promise<Response> => {
  // JUSTIFIED: req.json() returns unknown; narrowing to the query body
  const body = (await req.json()) as { query: string; params?: unknown[] };
  if (!body.query || !body.query.trim().toUpperCase().startsWith("SELECT")) {
    return json({ error: "only SELECT queries allowed" }, 400);
  }
  try {
    const results = read((db) => {
      // JUSTIFIED: dynamic user-supplied SQL — shape unknown at compile time,
      // so .as(Class) can't apply. Narrowing to Record<string, unknown>[] for
      // JSON serialization. Only SELECT queries are allowed (validated above).
      // JUSTIFIED: dynamic SQL shape unknown at compile time — Record<string, unknown>[]
      return db.query(body.query).all() as Record<string, unknown>[];
    });
    log("server", "info", "SQL query executed", { rows: results.length });
    return json({ rows: results, count: results.length });
  } catch (err) {
    return json({ error: "query failed", details: String(err) }, 422);
  }
});

// Bun.ffi — native library loading demo
// Ref: node_modules/bun-types/docs/runtime/ffi.mdx
const ffiHandler = withMiddleware<"">((): Response => {
  try {
    const { dlopen, FFIType, suffix } = require("bun:ffi") as typeof import("bun:ffi");
    const path = `libsqlite3.${suffix}`;
    // JUSTIFIED: dlopen returns complex Library type; CString → string via unknown
    const lib = dlopen(path, {
      sqlite3_libversion: { args: [], returns: FFIType.cstring },
    });
    const version = String(lib.symbols.sqlite3_libversion());
    return json({
      ffi: "working",
      library: path,
      sqlite3_version: version,
      note: "Bun.ffi loaded libsqlite3 natively — zero npm dependencies",
    });
  } catch (err) {
    return json({
      ffi: "available",
      error: String(err),
      note: "FFI module loaded but library not found (expected on some systems)",
    });
  }
});

// Bun.Image — image processing endpoint (resize/convert)
// Ref: node_modules/bun-types/docs/runtime/image.mdx
const imageProcessHandler = withAuth<"/api/image">(async (req: BunRequest<"/api/image">): Promise<Response> => {
  const url = new URL(req.url);
  const width = parseInt(url.searchParams.get("width") ?? "128", 10);
  const height = parseInt(url.searchParams.get("height") ?? "128", 10);
  const format = (url.searchParams.get("format") ?? "png") as "png" | "webp" | "jpeg";
  const srcPath = url.searchParams.get("src");
  if (!srcPath || srcPath.includes("..")) {
    return json({ error: "src parameter required (e.g. ?src=/icons/icon-512.png)" }, 400);
  }
  try {
    // Ref: node_modules/bun-types/docs/runtime/image.mdx
    const file = Bun.file(`public${srcPath}`);
    if (!file.size) return json({ error: "source file not found" }, 404);
    // Build the pipeline: decode → resize → format → blob (terminal)
    // Per image.mdx: .resize()/.webp()/.jpeg()/.png() are chainable (return this),
    // .blob() is the terminal that runs the pipeline off-thread and returns Blob.
    const pipeline = file.image().resize(width, height, { fit: "inside" });
    if (format === "webp") {
      pipeline.webp({ quality: 80 });
    } else if (format === "jpeg") {
      pipeline.jpeg({ quality: 80 });
    } else {
      pipeline.png();
    }
    const output = await pipeline.blob();
    return new Response(output, {
      headers: {
        "Content-Type": `image/${format}`,
        "Cache-Control": "public, max-age=3600",
        "X-Image-Original": file.size.toString(),
        "X-Image-Resized": `${width}x${height}`,
      },
    });
  } catch (err) {
    return json({ error: "image processing failed", details: String(err) }, 500);
  }
});

// Bun.hashing — hash verification endpoint
// Ref: node_modules/bun-types/docs/runtime/hashing.mdx
const hashHandler = withMiddleware<"/api/hash">((req: BunRequest<"/api/hash">): Response => {
  const url = new URL(req.url);
  const input = url.searchParams.get("input");
  const algorithm = (url.searchParams.get("algorithm") ?? "sha256") as "sha256" | "sha512" | "md5" | "sha1";
  if (!input) {
    return json({ error: "input parameter required (e.g. ?input=hello)" }, 400);
  }
  // Ref: node_modules/bun-types/docs/runtime/hashing.mdx
  const hash = Bun.CryptoHasher.hash(algorithm, input, "hex");
  return json({ input, algorithm, hash, length: hash.length });
});

// Screenshot endpoint via Bun.WebView
// Ref: node_modules/bun-types/docs/runtime/webview.mdx
const screenshotHandler = withAuth<"/api/screenshot">(async (req: BunRequest<"/api/screenshot">): Promise<Response> => {
  const url = new URL(req.url);
  const targetUrl = url.searchParams.get("url");
  const width = parseInt(url.searchParams.get("width") ?? "1280", 10);
  const height = parseInt(url.searchParams.get("height") ?? "720", 10);
  if (!targetUrl) {
    return json({ error: "url parameter required (e.g. ?url=https://example.com)" }, 400);
  }
  if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
    return json({ error: "url must start with http:// or https://" }, 400);
  }
  try {
    // Ref: node_modules/bun-types/docs/runtime/webview.mdx#screenshot
    await using view = new Bun.WebView({ width, height, url: targetUrl });
    await view.navigate(targetUrl);
    await Bun.sleep(1000);
    const screenshot = await view.screenshot();
    log("server", "info", "Screenshot captured", { url: targetUrl, size: screenshot.size });
    return new Response(screenshot, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=300",
        "X-Screenshot-URL": targetUrl,
      },
    });
  } catch (err) {
    return json({ error: "screenshot failed", details: String(err) }, 500);
  }
});

// Config editor — write YAML/TOML/JSON5
// Ref: node_modules/bun-types/docs/runtime/yaml.mdx
// Ref: node_modules/bun-types/docs/runtime/toml.mdx
// Ref: node_modules/bun-types/docs/runtime/json5.mdx
const configWriteHandler = withCsrf<"/api/config/write">(
  async (req: BunRequest<"/api/config/write">): Promise<Response> => {
    // JUSTIFIED: req.json() returns unknown; narrowing to the config write body
    const body = (await req.json()) as {
      format: "yaml" | "toml" | "json5";
      data: Record<string, unknown>;
      filename: string;
    };
    if (!body.data || !body.format || !body.filename) {
      return json({ error: "format, data, and filename required" }, 400);
    }
    if (body.filename.includes("..") || body.filename.includes("/")) {
      return json({ error: "filename must be a simple name (no paths)" }, 400);
    }
    try {
      let content: string;
      if (body.format === "yaml") {
        // JUSTIFIED: Bun.YAML.stringify exists per yaml.mdx but not in all bun-types versions
        const yamlStr = (Bun.YAML as { stringify?: (d: unknown) => string }).stringify?.(body.data);
        content = yamlStr ?? JSON.stringify(body.data, null, 2);
      } else if (body.format === "toml") {
        // JUSTIFIED: Bun.TOML.stringify exists per toml.mdx but not in all bun-types versions
        const tomlStr = (Bun.TOML as { stringify?: (d: unknown) => string }).stringify?.(body.data);
        content = tomlStr ?? JSON.stringify(body.data, null, 2);
      } else {
        // JUSTIFIED: Bun.JSON5.stringify exists per json5.mdx but return type may be optional
        content = Bun.JSON5.stringify(body.data) ?? JSON.stringify(body.data, null, 2);
      }
      const path = `./exports/${body.filename}.${body.format === "json5" ? "json5" : body.format}`;
      await Bun.write(path, content);
      await audit({ action: "config_write", resource: path, details: `format=${body.format}` });
      log("server", "info", "Config file written", { path, format: body.format });
      return json({ ok: true, path, size: content.length });
    } catch (err) {
      return json({ error: "write failed", details: String(err) }, 500);
    }
  },
);

// Bun.Transpiler — transpile TS/JSX to JS
// Ref: node_modules/bun-types/docs/runtime/transpiler.mdx
const transpileHandler = withMiddleware<"/api/transpile">((req: BunRequest<"/api/transpile">): Response => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const target = (url.searchParams.get("target") ?? "browser") as "browser" | "bun";
  if (!code) {
    return json({ error: "code parameter required (e.g. ?code=const x: number = 1)" }, 400);
  }
  try {
    // JUSTIFIED: Bun.Transpiler per transpiler.mdx — constructor accepts options
    const transpiler = new Bun.Transpiler({
      loader: "tsx",
      target: target === "bun" ? "bun" : "browser",
    });
    // JUSTIFIED: .transformSync returns string per transpiler.mdx
    const output = transpiler.transformSync(code) as string;
    return json({ input: code, output, inputSize: code.length, outputSize: output.length, target });
  } catch (err) {
    return json({ error: "transpile failed", details: String(err) }, 422);
  }
});

// Bun.dns — DNS lookup endpoint
// Ref: node_modules/bun-types/bun.d.ts#dns
const dnsHandler = withMiddleware<"/api/dns">((req: BunRequest<"/api/dns">): Response => {
  const url = new URL(req.url);
  const host = url.searchParams.get("host");
  if (!host) {
    return json({ error: "host parameter required (e.g. ?host=example.com)" }, 400);
  }
  return new Response(
    JSON.stringify({
      error: "use POST /api/dns for async DNS lookup",
      hint: "GET /api/dns?host=example.com returns this message; POST with {host} for results",
    }),
    { headers: { "Content-Type": "application/json" } },
  );
});

// Async DNS lookup handler (POST)
const dnsLookupHandler = withMiddleware<"/api/dns">((req: BunRequest<"/api/dns">): Response | Promise<Response> => {
  if (req.method !== "POST") {
    return json({ error: "POST required with {host: 'example.com'}" }, 405);
  }
  return req.json().then((body: unknown) => {
    // JUSTIFIED: body is unknown from req.json(); narrowing to dns lookup shape
    const { host } = body as { host?: string };
    if (!host) {
      return json({ error: "host required in body" }, 400);
    }
    // Ref: node_modules/bun-types/bun.d.ts#dns.lookup
    return Bun.dns
      .lookup(host)
      .then((results) => {
        return json({
          host,
          results: results.map((r) => ({ address: r.address, family: r.family })),
          count: results.length,
        });
      })
      .catch((err: Error) => {
        return json({ error: "DNS lookup failed", details: String(err) }, 502);
      });
  });
});

// Bun.file — filesystem browser
// Ref: node_modules/bun-types/docs/runtime/file.mdx
const fsBrowserHandler = withAuth<"/api/fs">((req: BunRequest<"/api/fs">): Response => {
  const url = new URL(req.url);
  const dirPath = url.searchParams.get("path") ?? ".";
  if (dirPath.includes("..") || dirPath.startsWith("/")) {
    return json({ error: "path must be within project directory" }, 403);
  }
  try {
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const entries = readdirSync(dirPath, { withFileTypes: true });
    const files = entries
      .map((entry) => {
        const fullPath = `${dirPath}/${entry.name}`;
        const isDir = entry.isDirectory();
        const stat = isDir ? null : statSync(fullPath);
        return {
          name: entry.name,
          path: fullPath,
          size: isDir ? 0 : stat!.size,
          type: isDir ? "directory" : Bun.file(fullPath).type,
          lastModified: isDir ? 0 : stat!.mtimeMs,
        };
      })
      .sort((a, b) => {
        if (a.type === "directory" && b.type !== "directory") return -1;
        if (a.type !== "directory" && b.type === "directory") return 1;
        return a.name.localeCompare(b.name);
      });
    return json({ path: dirPath, files, count: files.length });
  } catch (err) {
    return json({ error: "filesystem browse failed", details: String(err) }, 500);
  }
});

// Bun.deflateSync/inflateSync — compression utility
// Ref: node_modules/bun-types/bun.d.ts#deflateSync
const compressHandler = withMiddleware<"/api/compress">((req: BunRequest<"/api/compress">): Response => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "compress";
  const input = url.searchParams.get("input");
  if (!input) {
    return json({ error: "input parameter required" }, 400);
  }
  try {
    if (action === "compress") {
      const compressed = Bun.deflateSync(new TextEncoder().encode(input));
      const b64 = btoa(String.fromCharCode(...compressed));
      return json({
        action: "compress",
        input,
        inputSize: input.length,
        compressedSize: compressed.byteLength,
        compressed: b64,
        ratio: `${((compressed.byteLength / input.length) * 100).toFixed(1)}%`,
      });
    } else if (action === "decompress") {
      const bytes = Uint8Array.from(atob(input), (c) => c.charCodeAt(0));
      const decompressed = Bun.inflateSync(bytes);
      const text = new TextDecoder().decode(decompressed);
      return json({
        action: "decompress",
        input,
        inputSize: input.length,
        decompressedSize: decompressed.byteLength,
        decompressed: text,
      });
    } else {
      return json({ error: "action must be 'compress' or 'decompress'" }, 400);
    }
  } catch (err) {
    return json({ error: "compression failed", details: String(err) }, 500);
  }
});

// Utility endpoints — escapeHTML, base64, structuredClone
const utilsHandler = withMiddleware<"/api/utils">((req: BunRequest<"/api/utils">): Response => {
  const url = new URL(req.url);
  const tool = url.searchParams.get("tool") ?? "escape";
  const input = url.searchParams.get("input");
  if (!input) {
    return json({ error: "input parameter required" }, 400);
  }
  switch (tool) {
    case "escape":
      // Ref: node_modules/bun-types/bun.d.ts#escapeHTML
      return json({ tool: "escapeHTML", input, output: Bun.escapeHTML(input) });
    case "base64-encode":
      return json({ tool: "base64-encode", input, output: btoa(input) });
    case "base64-decode":
      try {
        return json({ tool: "base64-decode", input, output: atob(input) });
      } catch {
        return json({ error: "invalid base64 input" }, 400);
      }
    case "clone": {
      // JUSTIFIED: structuredClone is a global, not Bun-specific, but useful
      const cloned = structuredClone(JSON.parse(input));
      return json({ tool: "structuredClone", input, output: cloned });
    }
    case "urlencode":
      return json({ tool: "urlencode", input, output: encodeURIComponent(input) });
    case "urldecode":
      try {
        return json({ tool: "urldecode", input, output: decodeURIComponent(input) });
      } catch {
        return json({ error: "invalid URL-encoded input" }, 400);
      }
    default:
      return json(
        { error: "unknown tool. Available: escape, base64-encode, base64-decode, clone, urlencode, urldecode" },
        400,
      );
  }
});

// Bun.glob — auto-discover diagram files
// Ref: node_modules/bun-types/docs/runtime/glob.mdx
const diagramsListHandler = withMiddleware<"">(async (): Promise<Response> => {
  const { Glob } = await import("bun");
  const glob = new Glob("**/*.mmd");
  const diagrams: string[] = [];
  for await (const file of glob.scan("./docs")) {
    diagrams.push(file);
  }
  const glob2 = new Glob("**/*.mermaid");
  for await (const file of glob2.scan("./docs")) {
    diagrams.push(file);
  }
  return json({ diagrams, count: diagrams.length });
});

// Bun.YAML/TOML/JSON5 — multi-format config parser
// Ref: node_modules/bun-types/docs/runtime/yaml.mdx
// Ref: node_modules/bun-types/docs/runtime/toml.mdx
// Ref: node_modules/bun-types/docs/runtime/json5.mdx
const configHandler = withMiddleware<"">(async (req: BunRequest<"">): Promise<Response> => {
  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "all";
  const result: Record<string, unknown> = {};

  if (format === "all" || format === "toml") {
    try {
      const tomlFile = Bun.file("bunfig.toml");
      if (await tomlFile.exists()) {
        result.toml = Bun.TOML.parse(await tomlFile.text());
      }
    } catch {
      result.toml = null;
    }
  }
  if (format === "all" || format === "yaml") {
    try {
      const yamlFile = Bun.file("docker-compose.yml");
      if (await yamlFile.exists()) {
        result.yaml = Bun.YAML.parse(await yamlFile.text());
      }
    } catch {
      result.yaml = null;
    }
  }
  if (format === "all" || format === "json5") {
    try {
      const json5File = Bun.file("tsconfig.json5");
      if (await json5File.exists()) {
        result.json5 = Bun.JSON5.parse(await json5File.text());
      }
    } catch {
      result.json5 = null;
    }
  }
  if (format === "all" || format === "json") {
    try {
      const pkgFile = Bun.file("package.json");
      if (await pkgFile.exists()) {
        result.json = await pkgFile.json();
      }
    } catch {
      result.json = null;
    }
  }

  return json({ format, config: result, bunVersion: Bun.version });
});

// Tar export bundle — all JSONL exports in a single .tar download
// Ref: node_modules/bun-types/docs/runtime/archive.mdx
const exportBundleHandler = withAuth<"">(async (req: BunRequest<"">): Promise<Response> => {
  const url = new URL(req.url);
  const useGzip = url.searchParams.get("gzip") === "1";
  const { createExportBundle, createCompressedExportBundle } = await import("../utils/archive");

  if (useGzip) {
    const bundle = await createCompressedExportBundle();
    // JUSTIFIED: gzip Uint8Array is a valid Response body; DOM BodyInit omits ArrayBufferLike
    return new Response(bundle.data as BodyInit, {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="bun-dev-export-${bundle.date}.tar.gz"`,
        "X-Export-Files": bundle.files.join(", "),
        "X-Export-Original-Size": bundle.originalSize.toString(),
        "X-Export-Compressed-Size": bundle.compressedSize.toString(),
        "X-Export-Ratio": `${((bundle.compressedSize / bundle.originalSize) * 100).toFixed(1)}%`,
      },
    });
  }

  const { archive, date, files } = createExportBundle();
  // JUSTIFIED: Bun.Archive is Blob-like; Response accepts it per archive.mdx docs
  return new Response(archive as unknown as ArrayBuffer, {
    headers: {
      "Content-Type": "application/x-tar",
      "Content-Disposition": `attachment; filename="bun-dev-export-${date}.tar"`,
      "X-Export-Files": files.join(", "),
    },
  });
});

// --- Route exports ---------------------------------------------------------

export const apiRoutes = router({
  "/api/mermaid": { POST: mermaidRenderHandler },
  "/api/redis": { GET: redisRateLimitHandler },
  "/api/stream/:path": { GET: streamFileHandler },
  "/api/sql": { POST: sqlQueryHandler },
  "/api/ffi": { GET: ffiHandler },
  "/api/image": { GET: imageProcessHandler },
  "/api/hash": { GET: hashHandler },
  "/api/screenshot": { GET: screenshotHandler },
  "/api/config/write": { POST: configWriteHandler },
  "/api/transpile": { GET: transpileHandler },
  "/api/dns": { GET: dnsHandler, POST: dnsLookupHandler },
  "/api/fs": { GET: fsBrowserHandler },
  "/api/compress": { GET: compressHandler },
  "/api/utils": { GET: utilsHandler },
  "/api/diagrams": { GET: diagramsListHandler },
  "/api/config": { GET: configHandler },
  "/api/export/bundle.tar": { GET: exportBundleHandler },
});
