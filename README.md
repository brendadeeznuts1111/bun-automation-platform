# Bun Automation Platform

A production-grade browser automation platform built on Bun v1.3.14 — orchestrates headless browser sessions, processes screenshots, and exposes a REST API for task management. Includes a Mermaid diagram rendering pipeline and architecture blueprints.

## Features

- **REST API** — agent auth, task creation, session listing, screenshot serving, audit log
- **Worker pool** — pre-spawned Bun processes with native IPC, circuit breaker, retry logic
- **SQLite data layer** — WAL mode, read pool, serialized writes, auto-migration
- **Screenshot pipeline** — `Bun.Image` resize/WebP conversion with thumbnail support
- **Production middleware** — rate limiting (rolling window), CORS, audit logging
- **Graceful shutdown** — SIGTERM handling, worker drain, IPC coordination
- **Mermaid renderer** — `Bun.spawn` + `using` + watchdog + HTTP/3 URL fetch
- **Prometheus metrics** — `/metrics` endpoint with task counts and pool status

## Docs

| File | Description |
|------|-------------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Complete unified platform architecture with all v1.3.14 features |
| [BUN_API_REFERENCE.md](BUN_API_REFERENCE.md) | Every Bun API used in the platform — version, stability, code examples, links |
| [OPEN_TASKS.md](OPEN_TASKS.md) | Grounded task outline with Bun doc references + `Bun.markdown` deep reference |
| [BACKLOG.md](BACKLOG.md) | Gap analysis: production hardening, scalability, security, UX, and roadmap |

## Quick start

```bash
bun install

# Start the platform server (default: http://0.0.0.0:3000)
bun run start

# Seed a test agent
bun run seed

# Type-check
bun run check

# Run tests
bun test
```

### API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check + worker pool status |
| `GET` | `/metrics` | Prometheus-format metrics |
| `POST` | `/login` | Agent authentication (`username`, `password` → `token`) |
| `GET` | `/tasks` | List tasks (`?limit=50&offset=0&status=pending`) |
| `POST` | `/task` | Create task (`agent_id`, `url`, `priority?`) — dispatches to worker pool |
| `GET` | `/task/:id` | Get task by ID |
| `GET` | `/sessions` | List sessions (pagination) |
| `GET` | `/screenshot/:id` | Serve screenshot (`?w=400&format=jpeg`) |
| `GET` | `/audit` | Audit log (`?limit=50&offset=0&agent_id=1`) |

### Build a standalone executable

```bash
bun run build
# → ./server (61 MB, self-contained, no Bun runtime needed)
```

## Mermaid renderer

```bash
# Render to SVG (default)
bun run render-mermaid.ts bun_no_orphans_20260814.mmd

# Render to PNG with explicit output name
MERMAID_FORMAT=png bun run render-mermaid.ts bun_no_orphans_20260814.mmd custom.png

# Render from a URL (tries HTTP/3, falls back to HTTP/1.1)
bun run render-mermaid.ts https://example.com/diagram.mmd
```

The renderer handles the hard parts of invoking mermaid-cli from within Bun:

- **`Bun.spawn` with inherited stdio** — avoids the `$` template pipe deadlock that hangs nested mmdc calls
- **Strips `BUN_OPTIONS`** from child env — `--hot` keeps the event loop alive after render, causing mmdc to never exit
- **`TempDir` with `Symbol.dispose`** — temp Chrome profile dir auto-cleans via `using` (Bun v1.3.14 native)
- **Watchdog timeout** — kills hung mmdc processes after `MERMAID_TIMEOUT_MS`
- **Stale-dir sweep** — cleans up temp dirs from SIGKILL'd runs (age-thresholded, concurrent-safe)
- **`process.execPath`** — uses the current Bun binary, not a hardcoded path
- **URL input with HTTP/3** — accepts URLs as input, fetches via QUIC with HTTP/1.1 fallback

## Dev server (HTTP/3 + QUIC)

```bash
# Generate self-signed cert (one-time)
openssl req -x509 -newkey rsa:2048 -keyout dev-key.pem -out dev-cert.pem -days 365 -nodes -subj "/CN=localhost"

# Start the dev server
bun run dev-server.ts
```

- HTTP/1.1 on TCP, HTTP/3 on UDP (same port)
- `Alt-Svc` header for browser auto-upgrade
- Endpoints: `/`, `/health`, `/protocol`

## Configuration

All config is in `.env` (loaded automatically by Bun — no dotenv needed). Environment-specific overrides in `.env.development` and `.env.production`.

### Server

| Env var | Default | Description |
|---------|---------|-------------|
| `PORT` | `3000` | HTTP listen port |
| `HOST` | `0.0.0.0` | HTTP listen host |
| `NODE_ENV` | `development` | Runtime environment |
| `DB_PATH` | `./data/platform.db` | SQLite database file |
| `DB_READERS` | `4` | Read-only SQLite connections |
| `WORKER_POOL_SIZE` | `4` | Pre-spawned worker processes |
| `SHUTDOWN_TIMEOUT_MS` | `30000` | Max wait for workers during shutdown |
| `SCREENSHOT_DIR` | `./data/screenshots` | Processed screenshot directory |
| `THUMBNAIL_WIDTH` | `400` | Thumbnail width in pixels |
| `THUMBNAIL_QUALITY` | `85` | Thumbnail WebP quality (1–100) |
| `SCREENSHOT_QUALITY` | `90` | Full-size WebP quality (1–100) |
| `CIRCUIT_BREAKER_THRESHOLD` | `5` | Failures before circuit opens |
| `CIRCUIT_BREAKER_COOLDOWN_MS` | `300000` | Cooldown before half-open probe (5 min) |
| `CORS_ALLOWED_ORIGINS` | — | Comma-separated allowed origins (empty = allow all in dev) |

### Mermaid renderer

| Env var | Default | Description |
|---------|---------|-------------|
| `MERMAID_BROWSER_PATH` | — | Path to a Chromium binary (required) |
| `MERMAID_THEME` | `default` | `default` \| `forest` \| `dark` \| `neutral` |
| `MERMAID_FORMAT` | `svg` | `svg` \| `png` \| `pdf` |
| `MERMAID_OUTPUT_DIR` | `.` | Output directory |
| `MERMAID_TIMEOUT_MS` | `15000` | Watchdog timeout for hung renders |

### Brand colors

| Env var | Description |
|---------|-------------|
| `BRAND_COLOR_BG` | Canvas background (CSS color, passed to `-b`) |
| `BRAND_COLOR_LABEL` | Terminal label color |
| `BRAND_COLOR_VALUE` | Terminal value color |
| `BRAND_COLOR_OK` | Terminal success color |
| `BRAND_COLOR_ERR` | Terminal error color |
| `BRAND_COLOR_WARN` | Terminal warning color |

## Project layout

```
bun-automation-platform/
├── src/
│   ├── server.ts              # Main server — Bun.serve, routes, auth, tasks, sessions
│   ├── db/
│   │   ├── index.ts           # SQLite layer — WAL, read pool, write mutex, migrations
│   │   └── audit.ts           # Audit log queries
│   ├── middleware/
│   │   ├── cors.ts            # CORS preflight + headers
│   │   └── rate-limit.ts      # Rolling-window rate limiting (SQLite)
│   ├── utils/
│   │   ├── circuit-breaker.ts # Per-host circuit breaker
│   │   ├── image.ts           # Bun.Image screenshot processing (resize, WebP)
│   │   ├── retry.ts           # Exponential backoff retry
│   │   └── shutdown.ts        # Graceful shutdown (SIGTERM, worker drain)
│   ├── workers/
│   │   ├── pool.ts            # Pre-spawned worker pool with IPC
│   │   └── task-worker.ts     # Task execution (WebView stub, retry, circuit breaker)
│   └── types/
│       └── env.d.ts           # Typed env vars (augments Bun.Env)
├── render-mermaid.ts          # Mermaid renderer (Bun.spawn + using + watchdog + HTTP/3)
├── dev-server.ts              # Dev server with HTTP/3 (QUIC) + Alt-Svc
├── seed-agent.ts              # Seed a test agent
├── bunfig.toml                # Bun config (globalStore = true)
├── tsconfig.json              # Strict TypeScript config (bundler mode, path aliases)
├── package.json               # Scripts: start, dev, build, seed, test, check
├── .env                       # Shared config (browser path, theme, colors)
├── .env.development           # Dev overrides (verbose fetch, force color, --hot)
├── .env.production            # Prod overrides (no color, no telemetry)
├── ARCHITECTURE.md            # Unified platform architecture
├── BUN_API_REFERENCE.md       # Complete Bun API reference table
├── OPEN_TASKS.md              # Grounded task outline + Bun.markdown deep reference
├── BACKLOG.md                 # Gap analysis and roadmap
├── *.mmd                      # Mermaid diagram sources
├── *.svg                      # Rendered diagram output
└── data/                      # SQLite database (gitignored)
```

## Diagram index

### Architecture blueprints

| Diagram | Description | Source |
|---------|-------------|--------|
| [Bun Automation Platform — Final](bun_automation_platform_final_v1314_20260814.svg) | Complete unified architecture with all v1.3.14 features | [`.mmd`](bun_automation_platform_final_v1314_20260814.mmd) |
| [Bun Automation Platform — v1.3.14](bun_automation_platform_v1314_20260814.svg) | Updated architecture with v1.3.14 features (earlier draft) | [`.mmd`](bun_automation_platform_v1314_20260814.mmd) |
| [Bun Automation Platform — Original](bun_automation_platform_20260814.svg) | Initial implementation drill-down | [`.mmd`](bun_automation_platform_20260814.mmd) |
| [Agent Dashboard (DeepSeek)](deepseek_mermaid_20260814_ef065a.svg) | Original DeepSeek-generated architecture diagram | [`.mmd`](deepseek_mermaid_20260814_ef065a.mmd) |

### Bun API reference diagrams

| Diagram | Description | Source |
|---------|-------------|--------|
| [`Bun.color` API](bun_color_api_20260814.svg) | API surface — formats, inputs, outputs, ANSI, bundle-time macro | [`.mmd`](bun_color_api_20260814.mmd) |
| [`Bun.color` + Env Vars](bun_color_envvars_20260814.svg) | Integration matrix between color and environment variables | [`.mmd`](bun_color_envvars_20260814.mmd) |
| [Bun Config Env Vars](bun_config_envvars_20260814.svg) | Runtime configuration environment variables | [`.mmd`](bun_config_envvars_20260814.mmd) |
| [Bun .env Examples](bun_env_examples_20260814.svg) | Production vs development env file examples | [`.mmd`](bun_env_examples_20260814.mmd) |

### Feature deep-dives

| Diagram | Description | Source |
|---------|-------------|--------|
| [`--no-orphans`](bun_no_orphans_20260814.svg) | Kernel-level child process cleanup (prctl/kqueue/stop-verify-kill) | [`.mmd`](bun_no_orphans_20260814.mmd) |

## Tech stack

- **Runtime:** Bun v1.3.14+ (Zig-based, JavaScriptCore)
- **Language:** TypeScript (strict mode, bundler resolution, path aliases)
- **Database:** `bun:sqlite` (WAL mode, read pool, write mutex)
- **Browser automation:** `Bun.WebView` (WebKit on macOS, Chrome/CDP elsewhere)
- **Image processing:** `Bun.Image` (JPEG, PNG, WebP, HEIC, AVIF)
- **Process management:** `Bun.spawn` with IPC, `--no-orphans`, `process.execve`
- **Networking:** `fetch()` with HTTP/3 (QUIC), shared SSL_CTX cache
- **Rendering:** `@mermaid-js/mermaid-cli` via `Bun.spawn`
