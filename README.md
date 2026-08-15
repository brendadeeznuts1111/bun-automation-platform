# Bun Automation Platform

[![Bun](https://img.shields.io/badge/Bun-v1.3.14-black?logo=bun)](https://bun.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/Tests-56%20passed-success)](https://bun.com/docs/cli/test)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

A production-grade browser automation platform built natively on **Bun v1.3.14+**. Orchestrates headless browser sessions, processes screenshots via `Bun.Image`, provides atomic SQLite persistence with WAL mode, and exposes a high-performance REST API. Includes an automated Mermaid diagram rendering pipeline and architecture blueprints.

---

## Table of Contents

- [Features](#features)
- [Documentation](#documentation)
- [Quick Start](#quick-start)
- [API Endpoints](#api-endpoints)
- [Testing](#testing)
- [Build Standalone Executable](#build-standalone-executable)
- [Runtime & Debugging](#runtime--debugging)
- [Configuration](#configuration)
- [Mermaid Renderer](#mermaid-renderer)
- [Project Layout](#project-layout)
- [Architecture & Diagrams](#architecture--diagrams)
- [Tech Stack](#tech-stack)
- [License](#license)

---

## Features

- **High-Performance REST API** — Agent authentication, task queueing, session inspection, and audit logging.
- **Worker Process Pool** — Pre-spawned worker processes communicating via native `Bun.spawn` IPC with circuit breaker and exponential backoff retry.
- **SQLite Data Layer** — Built on `bun:sqlite` with WAL mode, serialized write mutex, connection pooling, and auto-migrations.
- **Zero-Dependency Image Pipeline** — Built on `Bun.Image` for asynchronous WebP conversion, thumbnailing, and ThumbHash blur placeholders.
- **Production Middleware** — Atomic rolling-window rate limiting (`INSERT ... RETURNING count`), CORS preflight handling, and audit trails.
- **Graceful Lifecycle** — Signal handling (`SIGTERM`, `SIGINT`, `SIGHUP`), worker drain timeouts, and clean database shutdown.
- **Mermaid Diagram Pipeline** — Automated diagram rendering via `Bun.spawn`, native `using` resource disposal, and HTTP/3 URL fetching.
- **Observability** — Built-in `/health` status and Prometheus-compatible `/metrics` exporter.

---

## Documentation

| Document | Description |
|:---|:---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Complete unified platform architecture, system diagrams, and v1.3.14 capabilities |
| [`BUN_API_REFERENCE.md`](BUN_API_REFERENCE.md) | Comprehensive API reference table with version mapping, code examples, and docs links |
| [`OPEN_TASKS.md`](OPEN_TASKS.md) | Grounded task backlog with Bun documentation references and `Bun.markdown` deep reference |
| [`BACKLOG.md`](BACKLOG.md) | Production hardening, scalability analysis, security mitigations, and roadmap |

---

## Quick Start

### 1. Install Dependencies

```bash
bun install
```

### 2. Run the Platform Server

```bash
# Start server in production mode
bun run start

# Start server with hot reloading
bun run dev
```

### 3. Seed an Agent

```bash
bun run seed
```

---

## API Endpoints

The server listens on `http://0.0.0.0:3000` by default:

| Method | Endpoint | Description |
|:---|:---|:---|
| `GET` | `/health` | Health check, uptime, and worker pool metrics |
| `GET` | `/metrics` | Prometheus-formatted metrics exporter |
| `POST` | `/login` | Agent authentication (returns session token) |
| `GET` | `/tasks` | List tasks with pagination (`?limit=50&offset=0&status=pending`) |
| `POST` | `/task` | Enqueue a new automation task to the worker pool |
| `GET` | `/task/:id` | Fetch task state, progress, and execution results |
| `GET` | `/sessions` | List active and expired browser sessions |
| `GET` | `/screenshot/:id` | Serve processed screenshots (`?w=400&format=webp\|jpeg\|png`) |
| `GET` | `/audit` | Query system audit logs with optional agent filter |

---

## Testing

The test suite runs with Bun's native test runner (`bun:test`):

```bash
# Run all tests
bun test

# Run tests in watch mode
bun test --watch

# Run TypeScript typecheck
bun run check
```

### Test Suite Overview

| Test Suite | File | Description |
|:---|:---|:---|
| **Server Integration** | [`tests/server.test.ts`](tests/server.test.ts) | End-to-end HTTP endpoint verification (`/health`, `/metrics`, `/tasks`, `/audit`) |
| **Shell & Processes** | [`tests/shell-process.test.ts`](tests/shell-process.test.ts) | `Bun.$` shell execution, pipes, `Bun.spawn` / `Bun.spawnSync`, `mock()`, `spyOn()`, `setSystemTime()` |
| **Native APIs & CLI** | [`tests/bun-apis.test.ts`](tests/bun-apis.test.ts) | Password hashing, CSRF, color formatting, compression, hashing, markdown, and heap profiling |
| **Rate Limiter** | [`tests/rate-limit.test.ts`](tests/rate-limit.test.ts) | Atomic SQLite sliding-window concurrency and threshold enforcement |
| **Circuit Breaker** | [`tests/circuit-breaker.test.ts`](tests/circuit-breaker.test.ts) | Per-host failure threshold tracking, tripping, and reset transitions |
| **Image Pipeline** | [`tests/image.test.ts`](tests/image.test.ts) | `Bun.Image` resizing, WebP compression, and metadata generation |
| **CORS Middleware** | [`tests/cors.test.ts`](tests/cors.test.ts) | Origin validation, preflight options handling, and header injection |
| **Database & Audit** | [`tests/db.test.ts`](tests/db.test.ts) | WAL mode concurrency, read pool load, write mutex serialization, and audit queries |
| **Retry Helper** | [`tests/retry.test.ts`](tests/retry.test.ts) | Exponential backoff, jitter calculation, and error filtering |

---

## Build Standalone Executable

Compile the entire application into a single self-contained binary with zero external dependencies:

```bash
bun run build
# Output: ./server (self-contained executable)
```

---

## Runtime & Debugging

The platform implements configurations aligned with Bun's official runtime guides:

| Feature | Configuration / Tool | Description |
|:---|:---|:---|
| **TypeScript** | [`tsconfig.json`](tsconfig.json) | Configured with `types: ["bun"]` and `moduleResolution: "bundler"` |
| **Path Aliases** | [`tsconfig.json`](tsconfig.json) | Clean imports via `@/*`, `@db/*`, `@middleware/*`, `@utils/*`, `@workers/*` |
| **VS Code Debugger** | [`.vscode/launch.json`](.vscode/launch.json) | Interactive debugging with native `type: "bun"` launch configurations |
| **Web Inspector** | `bun --inspect src/server.ts` | Remote debugging on port `6499` via [debug.bun.sh](https://debug.bun.sh) |
| **Heap Diagnostics** | `bun:jsc` | Runtime memory statistics via `heapStats()`, `memoryUsage()`, and snapshots |
| **CI / CD** | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | Automated GitHub Actions workflow using `oven-sh/setup-bun@v2` |
| **macOS Codesigning** | [`entitlements.plist`](entitlements.plist) | Hardened runtime entitlements for Gatekeeper validation on macOS |

---

## Configuration

Configuration is loaded automatically by Bun from `.env` files. Environment-specific overrides reside in `.env.development` and `.env.production`.

### Server Settings

| Variable | Default | Description |
|:---|:---|:---|
| `PORT` | `3000` | HTTP server listening port |
| `HOST` | `0.0.0.0` | HTTP server host binding |
| `NODE_ENV` | `development` | Active environment (`development` \| `production`) |
| `DB_PATH` | `./data/platform.db` | File path for SQLite database |
| `DB_READERS` | `4` | Number of read-only SQLite connections in pool |
| `WORKER_POOL_SIZE` | `4` | Number of pre-spawned worker processes |
| `SHUTDOWN_TIMEOUT_MS` | `30000` | Maximum wait time for worker drain during shutdown |
| `SCREENSHOT_DIR` | `./data/screenshots` | Target directory for processed screenshot storage |
| `THUMBNAIL_WIDTH` | `400` | Max width for thumbnail images (in pixels) |
| `THUMBNAIL_QUALITY` | `85` | WebP compression quality for thumbnails (`1–100`) |
| `SCREENSHOT_QUALITY` | `90` | WebP compression quality for full screenshots (`1–100`) |
| `CIRCUIT_BREAKER_THRESHOLD` | `5` | Consecutive failures before circuit trips open |
| `CIRCUIT_BREAKER_COOLDOWN_MS` | `300000` | Circuit breaker recovery cooldown period (5 minutes) |
| `CORS_ALLOWED_ORIGINS` | `""` | Comma-separated list of allowed origins (empty = allow in dev) |
| `TLS_CERT_PATH` | `dev-cert.pem` | Path to TLS certificate for HTTP/3 dev server |
| `TLS_KEY_PATH` | `dev-key.pem` | Path to TLS private key for HTTP/3 dev server |

### Mermaid Renderer Settings

| Variable | Default | Description |
|:---|:---|:---|
| `MERMAID_BROWSER_PATH` | — | Path to Chromium executable binary |
| `MERMAID_THEME` | `default` | Diagram theme (`default` \| `forest` \| `dark` \| `neutral`) |
| `MERMAID_FORMAT` | `svg` | Export format (`svg` \| `png` \| `pdf`) |
| `MERMAID_OUTPUT_DIR` | `.` | Target output directory for rendered files |
| `MERMAID_TIMEOUT_MS` | `15000` | Watchdog timeout for hanging render processes |

---

## Mermaid Renderer

The pipeline invokes `@mermaid-js/mermaid-cli` from Bun with robust process isolation:

```bash
# Render to SVG (default)
bun run render-mermaid.ts bun_no_orphans_20260814.mmd

# Render to PNG with explicit output filename
MERMAID_FORMAT=png bun run render-mermaid.ts bun_no_orphans_20260814.mmd custom.png

# Render directly from a remote URL (HTTP/3 with HTTP/1.1 fallback)
bun run render-mermaid.ts https://example.com/diagram.mmd
```

### Dev Server (HTTP/3 + QUIC)

```bash
# Generate self-signed certificate
openssl req -x509 -newkey rsa:2048 -keyout dev-key.pem -out dev-cert.pem -days 365 -nodes -subj "/CN=localhost"

# Start HTTP/3 dev server
bun run dev-server.ts
```

---

## Project Layout

```
bun-automation-platform/
├── src/
│   ├── server.ts              # Bun.serve HTTP server, REST endpoints & routing
│   ├── db/
│   │   ├── index.ts           # SQLite WAL pool, serialized write mutex & schema
│   │   └── audit.ts           # Audit log entry recording and pagination
│   ├── middleware/
│   │   ├── cors.ts            # CORS preflight options & header injection
│   │   └── rate-limit.ts      # Atomic sliding-window rate limiting
│   ├── utils/
│   │   ├── circuit-breaker.ts # Site-specific failure threshold breaker
│   │   ├── image.ts           # Bun.Image processing, WebP & ThumbHash
│   │   ├── retry.ts           # Exponential backoff with jitter helper
│   │   └── shutdown.ts        # Coordinated SIGTERM worker shutdown
│   ├── workers/
│   │   ├── pool.ts            # IPC-managed child process worker pool
│   │   └── task-worker.ts     # Task execution lifecycle & progress updates
│   └── types/
│       └── env.d.ts           # Typed environment variable declarations
├── tests/
│   ├── server.test.ts          # Server REST API integration test suite
│   ├── bun-apis.test.ts        # Native Bun APIs & utilities test suite
│   ├── rate-limit.test.ts      # Concurrency & rate-limiting test suite
│   ├── circuit-breaker.test.ts # Circuit breaker state transitions test suite
│   ├── image.test.ts           # Bun.Image transform & serving test suite
│   └── retry.test.ts           # Exponential backoff & jitter test suite
├── .github/workflows/ci.yml   # GitHub Actions automated test & build workflow
├── .vscode/launch.json        # Visual Studio Code & Windsurf debugger profile
├── entitlements.plist         # macOS Gatekeeper signing entitlements
├── render-mermaid.ts          # Mermaid diagram CLI renderer pipeline
├── dev-server.ts              # HTTP/3 dev server with Alt-Svc upgrade
├── seed-agent.ts              # Idempotent database agent initialization
├── bunfig.toml                # Project Bun configuration (globalStore = true)
├── tsconfig.json              # Strict TypeScript compiler options & paths
├── package.json               # Scripts, metadata, and dependencies
├── .env                       # Base configuration file
├── .env.development           # Development environment overrides
├── .env.production            # Production environment overrides
├── ARCHITECTURE.md            # Platform architecture documentation
├── BUN_API_REFERENCE.md       # Native Bun API reference table
├── OPEN_TASKS.md              # Backlog with canonical documentation links
└── BACKLOG.md                 # Gap analysis and production roadmap
```

---

## Architecture & Diagrams

### Architecture Blueprints

| Diagram | Description | Source |
|:---|:---|:---|
| [Bun Automation Platform — Final](bun_automation_platform_final_v1314_20260814.svg) | Complete unified architecture with all v1.3.14 features | [`.mmd`](bun_automation_platform_final_v1314_20260814.mmd) |
| [Bun Automation Platform — v1.3.14](bun_automation_platform_v1314_20260814.svg) | Updated architecture with v1.3.14 features (earlier draft) | [`.mmd`](bun_automation_platform_v1314_20260814.mmd) |
| [Bun Automation Platform — Original](bun_automation_platform_20260814.svg) | Initial implementation drill-down | [`.mmd`](bun_automation_platform_20260814.mmd) |
| [Agent Dashboard (DeepSeek)](deepseek_mermaid_20260814_ef065a.svg) | Original DeepSeek-generated architecture diagram | [`.mmd`](deepseek_mermaid_20260814_ef065a.mmd) |
| [Agent Dashboard (DeepSeek, PNG)](deepseek_mermaid_20260814_4f4804.png) | High-resolution rasterized diagram render | — |

### Bun API Reference Diagrams

| Diagram | Description | Source |
|:---|:---|:---|
| [`Bun.color` API](bun_color_api_20260814.svg) | API surface — formats, inputs, outputs, ANSI, bundle-time macro | [`.mmd`](bun_color_api_20260814.mmd) |
| [`Bun.color` + Env Vars](bun_color_envvars_20260814.svg) | Integration matrix between color and environment variables | [`.mmd`](bun_color_envvars_20260814.mmd) |
| [Bun Config Env Vars](bun_config_envvars_20260814.svg) | Runtime configuration environment variables | [`.mmd`](bun_config_envvars_20260814.mmd) |
| [Bun .env Examples](bun_env_examples_20260814.svg) | Production vs development env file examples | [`.mmd`](bun_env_examples_20260814.mmd) |

### Feature Deep-Dives

| Diagram | Description | Source |
|:---|:---|:---|
| [`--no-orphans`](bun_no_orphans_20260814.svg) | Kernel-level child process cleanup (prctl / kqueue / stop-verify-kill) | [`.mmd`](bun_no_orphans_20260814.mmd) |

---

## Tech Stack

- **Runtime:** [Bun v1.3.14+](https://bun.com) (Zig-based, JavaScriptCore)
- **Language:** [TypeScript](https://www.typescriptlang.org) (strict mode, bundler resolution, path aliases)
- **Database:** `bun:sqlite` (SQLite 3.53.0 with WAL mode, read pool, serialized write mutex)
- **Browser Automation:** `Bun.WebView` (WebKit on macOS, Chrome/CDP on Linux/Windows)
- **Image Processing:** `Bun.Image` (JPEG, PNG, WebP, HEIC, AVIF, ThumbHash)
- **Process Orchestration:** `Bun.spawn` with native IPC, `--no-orphans`, and `process.execve`
- **Networking:** HTTP/3 (QUIC) in `fetch()` & `Bun.serve`, shared `SSL_CTX` cache
- **Diagram Rendering:** `@mermaid-js/mermaid-cli` via isolated `Bun.spawn` child processes

---

## License

[MIT](LICENSE) © 2026 nolarose
