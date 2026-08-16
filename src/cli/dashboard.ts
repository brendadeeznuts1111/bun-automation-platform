#!/usr/bin/env bun
/**
 * CLI Dashboard — terminal-rendered status via Bun.markdown.ansi()
 *
 * Usage: bun run src/cli/dashboard.ts
 * Ref: node_modules/bun-types/docs/runtime/markdown.mdx
 * Ref: https://bun.com/blog/bun-v1.3.12 — "Render Markdown in the Terminal"
 */

import { getPoolStatus } from "../workers/pool";

const pool = getPoolStatus();
const uptime = Math.floor(process.uptime());
const uptimeStr = uptime > 60 ? `${Math.floor(uptime / 60)}m ${uptime % 60}s` : `${uptime}s`;

const md = `# BUN-DEV Status

**Bun version:** ${Bun.version}
**PID:** ${process.pid}
**Uptime:** ${uptimeStr}

## Worker Pool

| Metric | Value |
|--------|-------|
| Total | ${pool.total} |
| Busy | ${pool.busy} |
| Idle | ${pool.idle} |
| Queued | ${pool.queued} |

## Environment

- **NODE_ENV:** ${process.env.NODE_ENV ?? "development"}
- **Platform:** ${process.platform}
- **Arch:** ${process.arch}

> Run \`bun run src/server.ts\` to start the full server with dashboard at /dashboard
`;

// Bun.markdown.ansi renders markdown as colored ANSI terminal output
// Ref: node_modules/bun-types/docs/runtime/markdown.mdx#ansi
const ansi = Bun.markdown.ansi(md);
console.log(ansi);

// Bun.sliceAnsi — ANSI-aware string slicing (preserves escape codes)
// Ref: bun.d.ts — sliceAnsi(str, start, end, opts)
// Blog: v1.3.11 — "Bun.sliceAnsi — ANSI & grapheme-aware string slicing"
import { sliceAnsi } from "bun";

const statusLine = "\x1b[32m✅ BUN-DEV\x1b[0m — running normally";
const sliced = sliceAnsi(statusLine, 0, 20);
console.log("\n" + sliced + "...");

// Show available Bun APIs
const apis = [
  "Bun.serve", "Bun.sqlite", "Bun.WebView", "Bun.cron", "Bun.secrets",
  "Bun.Image", "Bun.Archive", "Bun.glob", "Bun.shell", "Bun.redis",
  "Bun.s3", "Bun.sql", "Bun.semver", "Bun.YAML", "Bun.TOML", "Bun.JSON5",
  "Bun.CryptoHasher", "Bun.CSRF", "Bun.password", "Bun.markdown",
  "Bun.color", "Bun.JSONL", "Bun.XML", "Bun.CookieMap", "Bun.ffi",
  "Bun.streams", "Bun.sliceAnsi",
];

console.log("\n\x1b[36mIntegrated Bun APIs:\x1b[0m");
const apiLine = apis.join(", ");
// sliceAnsi truncates to terminal width while preserving colors
const termWidth = process.stdout.columns ?? 80;
if (apiLine.length > termWidth) {
  console.log(sliceAnsi(apiLine, 0, termWidth - 3) + "...");
} else {
  console.log(apiLine);
}
console.log(`\n\x1b[2m${apis.length} APIs integrated — ${(apis.length / 30 * 100).toFixed(0)}% coverage\x1b[0m`);
