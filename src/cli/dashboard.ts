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
