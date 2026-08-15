# Project Rules — Bun Automation Platform

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
- Run worker: `bun run src/workers/task-worker.ts`

## Architecture

- `src/server.ts` — Bun.serve HTTP server with routes, middleware, worker pool
- `src/workers/` — Bun.spawn worker pool + Bun.WebView task execution
- `src/db/` — bun:sqlite with WAL mode, writer + reader pool
- `src/middleware/` — auth (Bearer token), CSRF, CORS, rate limiting
- `src/utils/` — image processing, circuit breaker, retry, shutdown
- `tests/` — bun:test with 85% coverage threshold (lines + functions)
