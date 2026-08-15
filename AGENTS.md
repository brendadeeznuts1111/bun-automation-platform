# Project Rules — Bun Automation Platform

> See also: CLAUDE.md for Bun API selection guidelines (which APIs to use
> instead of Node equivalents). This file covers *verification* rules — how
> to ensure Bun API calls are correct before writing them.

## MANDATORY: Read docs before writing Bun API calls

Bun's canonical documentation is installed locally at `node_modules/bun-types/docs/`.
There are 331 `.mdx` files covering every Bun API. **Read the relevant doc before
calling any Bun API you're not 100% certain about.**

Key docs:
- `node_modules/bun-types/docs/runtime/webview.mdx` — Bun.WebView
- `node_modules/bun-types/docs/runtime/sqlite.mdx` — bun:sqlite
- `node_modules/bun-types/docs/runtime/http/server.mdx` — Bun.serve
- `node_modules/bun-types/docs/runtime/csrf.mdx` — Bun.CSRF
- `node_modules/bun-types/docs/runtime/image.mdx` — Bun.Image

Type definitions are at `node_modules/bun-types/bun.d.ts`. If `tsc` rejects your
code, **read the type definition before adding a type cast.** The types are the
source of truth — if a property doesn't exist in the types, it doesn't exist in
the API, no matter what the docs say.

## MANDATORY: No type casts without justification

Type casts (`as`, `@ts-ignore`, `@ts-expect-error`) are **banned** unless
accompanied by a `// JUSTIFIED:` comment explaining:
1. Why the types are wrong (with evidence — link to the doc or type def)
2. Why the cast is safe

Example of an acceptable cast:
```ts
// JUSTIFIED: bun-types v1.3.14 doesn't export WebView.ConstructorOptions
// but the runtime accepts it per docs/runtime/webview.mdx#constructor
const view = new Bun.WebView(options as Bun.WebView.ConstructorOptions);
```

The pre-commit hook will **block** any commit containing `as`, `@ts-ignore`, or
`@ts-expect-error` without a `// JUSTIFIED:` comment on the same or preceding line.

## MANDATORY: Cite doc references in source comments

Every file that calls Bun APIs must include a comment citing the specific doc:
```ts
// Ref: node_modules/bun-types/docs/runtime/webview.mdx#navigation
```

## Build & test commands

- Typecheck: `bunx tsc --noEmit`
- Test: `bun test`
- Run server: `bun run src/server.ts`
- Run dev server (TLS + HTTP/3 + dashboard): `bun run dev:tls`
- Run dev server (dashboard only): `bun run dev:dashboard`
- Run worker: `bun run src/workers/task-worker.ts`

## Architecture

- `src/server.ts` — Bun.serve HTTP server with routes, middleware, worker pool
- `src/features/registry.ts` — Feature flag registry with promotion tracking
- `src/workers/` — Bun.spawn worker pool + Bun.WebView task execution
- `src/db/` — bun:sqlite with WAL mode, writer + reader pool
- `src/middleware/` — auth (Bearer token), CSRF, CORS, rate limiting
- `src/utils/` — image processing, circuit breaker, retry, shutdown
- `tests/` — bun:test with 85% coverage threshold (lines + functions)

## Feature flags

Gated features are tracked in `src/features/registry.ts`. Each feature has:
- `status`: `experimental` | `stable` | `promoted`
- `readyForPromotion`: boolean (true when safe to enable by default)
- `requested`: env var is set (user asked for it)
- `active`: feature is actually running (server called `markActive()`)
- `blocked`: requested but can't run (missing dependency)

### Available flags

| Flag | Env Var | Status | Notes |
|------|---------|--------|-------|
| TLS | `ENABLE_TLS=1` | stable | Requires `TLS_CERT_PATH` + `TLS_KEY_PATH` |
| HTTP/3 | `ENABLE_HTTP3=1` | experimental | Requires `ENABLE_TLS=1`. Not for production yet. |
| Dev dashboard | `ENABLE_DEV_DASHBOARD=1` | experimental | Auto-enabled in dev mode. Serves `/dashboard`. |
| WebSocket | `ENABLE_WEBSOCKET=1` | experimental | Not yet implemented (OPEN_TASKS C1, C2). |
| No-orphans | `BUN_FEATURE_FLAG_NO_ORPHANS=1` | stable | Set on worker subprocesses in pool.ts. |
| HTTP/3 client | `BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP3_CLIENT=1` | experimental | Used by render-mermaid.ts. |

### Endpoints

- `GET /features` — lists all feature flags with state (requested/active/blocked)
- `GET /protocol` — shows scheme, HTTP/3 status, Alt-Svc header
- `GET /dashboard` — HTML status page (when enabled)

### Promotion path

1. `experimental` → `stable`: when all tests pass and feature is verified
2. `stable` → `promoted`: when enabled by default in the next release
3. Update `src/features/registry.ts` to change status
