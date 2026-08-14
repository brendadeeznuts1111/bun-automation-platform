# artifacts-browser

Mermaid diagram rendering pipeline + Bun v1.3.14 architecture blueprints.

## Docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — Complete unified platform architecture with all v1.3.14 features
- [BACKLOG.md](BACKLOG.md) — Gap analysis: production hardening, scalability, security, UX, and roadmap

## Quick start

```bash
bun install
bun run render-mermaid.ts <diagram.mmd> [output.svg]
```

Output defaults to `<diagram-name>.<format>` in the current directory.
Format/theme/browser path are controlled by env vars (see `.env`).

## Render a diagram

```bash
# Render to SVG (default)
bun run render-mermaid.ts bun_no_orphans_20260814.mmd

# Render to PNG with explicit output name
MERMAID_FORMAT=png bun run render-mermaid.ts bun_no_orphans_20260814.mmd custom.png

# Open the result
open bun_no_orphans_20260814.svg
```

## Configuration

All config is in `.env` (loaded automatically by Bun — no dotenv needed).

| Env var | Default | Description |
|---------|---------|-------------|
| `MERMAID_BROWSER_PATH` | — | Path to a Chromium binary (required) |
| `MERMAID_THEME` | `default` | `default` \| `forest` \| `dark` \| `neutral` |
| `MERMAID_FORMAT` | `svg` | `svg` \| `png` \| `pdf` |
| `MERMAID_OUTPUT_DIR` | `.` | Output directory |
| `MERMAID_TIMEOUT_MS` | `15000` | Watchdog timeout for hung renders |
| `BRAND_COLOR_BG` | — | Canvas background (CSS color, passed to `-b`) |
| `BRAND_COLOR_LABEL` | — | Terminal label color |
| `BRAND_COLOR_VALUE` | — | Terminal value color |
| `BRAND_COLOR_OK` | — | Terminal success color |
| `BRAND_COLOR_ERR` | — | Terminal error color |
| `BRAND_COLOR_WARN` | — | Terminal warning color |

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

## render-mermaid.ts

The renderer handles the hard parts of invoking mermaid-cli from within Bun:

- **`Bun.spawn` with inherited stdio** — avoids the `$` template pipe deadlock that hangs nested mmdc calls
- **Strips `BUN_OPTIONS`** from child env — `--hot` keeps the event loop alive after render, causing mmdc to never exit
- **`TempDir` with `Symbol.dispose`** — temp Chrome profile dir auto-cleans via `using` (Bun v1.3.14 native)
- **Watchdog timeout** — kills hung mmdc processes after `MERMAID_TIMEOUT_MS`
- **Stale-dir sweep** — cleans up temp dirs from SIGKILL'd runs (age-thresholded, concurrent-safe)
- **`process.execPath`** — uses the current Bun binary, not a hardcoded path
- **URL input with HTTP/3** — accepts URLs as input, fetches via QUIC with HTTP/1.1 fallback

### URL inputs

The renderer accepts URLs as input — it fetches the `.mmd` content and renders it:

```bash
# Render a diagram from a URL (tries HTTP/3, falls back to HTTP/1.1)
bun run render-mermaid.ts https://example.com/diagram.mmd

# With self-signed certs (dev)
NODE_TLS_REJECT_UNAUTHORIZED=0 bun run render-mermaid.ts https://localhost:3001/diagram.mmd

# Enable HTTP/2 client for the fallback (experimental)
BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT=1 bun run render-mermaid.ts https://example.com/diagram.mmd
# or: bun --experimental-http2-fetch run render-mermaid.ts https://example.com/diagram.mmd
```

## dev-server.ts

Dev/staging server with HTTP/3 (QUIC) enabled:

```bash
# Generate self-signed cert (one-time)
openssl req -x509 -newkey rsa:2048 -keyout dev-key.pem -out dev-cert.pem -days 365 -nodes -subj "/CN=localhost"

# Start the server
bun run dev-server.ts
```

- HTTP/1.1 on TCP, HTTP/3 on UDP (same port)
- `Alt-Svc` header for browser auto-upgrade
- Endpoints: `/`, `/health`, `/protocol`

## Project layout

```
artifacts-browser/
├── render-mermaid.ts          # Mermaid renderer (Bun.spawn + using + watchdog + HTTP/3 fetch)
├── dev-server.ts              # Dev server with HTTP/3 (QUIC) + Alt-Svc
├── bunfig.toml                # Bun config (globalStore = true)
├── .env                       # Shared config (browser path, theme, colors)
├── .env.development           # Dev overrides (verbose fetch, force color, --hot)
├── .env.production            # Prod overrides (no color, no telemetry)
├── dev-cert.pem               # Self-signed TLS cert (gitignored, generated locally)
├── dev-key.pem                # Self-signed TLS key (gitignored, generated locally)
├── *.mmd                      # Mermaid diagram sources
├── *.svg                      # Rendered output
└── node_modules/
    └── @mermaid-js/mermaid-cli/
```
