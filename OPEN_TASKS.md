# Open Tasks — Grounded in Bun v1.3.14 Docs & Release Notes

Cross-referenced against:
- [Bun v1.3.14 release blog](https://bun.com/blog/bun-v1.3.14)
- [Bun docs](https://bun.com/docs/) — Server, Routing, WebSockets, WebView, Cron, CSRF, Secrets, Spawn, Image
- Current codebase (`src/` — 12 files, ~2000 lines)
- `BACKLOG.md` gap analysis

Each task cites the specific Bun API/doc that grounds it.

---

## A. Code Quality Fixes (existing code, no new features)

### A1. Migrate to `routes` property (Bun.serve docs — Routing)

**Current:** `src/server.ts` uses manual `path.match(/^\/task\/(\d+)$/)` regex matching inside a single `fetch()` handler. 326 lines of if/else chains.

**Doc pattern:** `Bun.serve({ routes: { "/task/:id": req => ..., "/users/:id": req => ... } })` — Bun's router does SIMD-accelerated param decoding, type-safe `req.params`, and static response caching. Per-method handlers (`GET`, `POST`) are supported natively.

**Action:** Rewrite server.ts to use the `routes` object. Eliminates all regex matching, gives type-safe params, and improves dispatch performance.

**Ref:** https://bun.com/docs/runtime/http/routing

### A2. Fix `require()` calls in ESM context (task-worker.ts:160,192)

**Current:** `require("node:zlib")` inside `encodePng()` and `crc32()` functions.

**Doc pattern:** Bun supports `require()` at runtime, but with `verbatimModuleSyntax: true` and ESM, top-level `import` is idiomatic.

**Action:** Move `import { deflateSync, crc32 } from "node:zlib"` to top of file.

### A3. Fix rate limit TOCTOU race (rate-limit.ts:50-67)

**Current:** `read()` checks count, then `write()` increments — not atomic. Under concurrent load, multiple requests can pass the check before any increment.

**Action:** Move both check and increment into a single `write()` call (serialized by the mutex). Use `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count` and check the returned count.

### A4. Remove `as any` cast in image.ts:122

**Current:** `img.resize(width, width, { fit: "inside" }) as any` — needed because `resize()` return type doesn't match.

**Action:** Check `@types/bun` for the correct return type. `Bun.Image.resize()` returns `Bun.Image` (chainable). The cast may be unnecessary with `@types/bun@1.3.14`.

---

## B. Security (Critical)

### B1. Auth middleware — token verification on all endpoints

**Current:** `/login` returns a base64 token (`btoa(agent_id:timestamp:uuid)`), but no endpoint checks it. Anyone can create tasks, list sessions, view audit logs.

**Doc pattern:** `Bun.serve` routes receive a `BunRequest` with `req.headers`. Add a middleware that extracts `Authorization: Bearer <token>`, decodes it, validates the agent_id exists, and rejects with 401.

**Action:** Create `src/middleware/auth.ts`. Apply to all routes except `/login` and `/health`. Store tokens in a `sessions` table (or use signed JWT via `Bun.CSRF` — see B3).

### B2. CSRF protection via `Bun.CSRF`

**Doc pattern:** `Bun.CSRF.generate(secret, { sessionId })` → token. `Bun.CSRF.verify(token, { secret, sessionId })` → boolean. HMAC-signed with expiration. Bind to session ID to prevent cross-user replay.

**Action:** Generate CSRF token on login, return it alongside the auth token. Require it on all state-changing requests (POST/PUT/DELETE) via `X-CSRF-Token` header.

**Ref:** https://bun.com/docs/runtime/csrf

### B3. Credential encryption via `Bun.secrets`

**Current:** `credentials` table has `username_enc`/`password_enc` columns but no encryption layer. `MASTER_KEY` is in `.env` (plaintext on disk).

**Doc pattern:** `Bun.secrets` uses OS keychain (macOS Keychain, Linux libsecret, Windows Credential Manager). `secrets.get({ service, name })` → `string | null`. `secrets.set({ service, name, value })`. Memory is zeroed after use.

**Action:** Store the master encryption key in `Bun.secrets` instead of `.env`. Use it to encrypt/decrypt credential fields with `Bun.hash` or AES-GCM via WebCrypto.

**Ref:** https://bun.com/docs/runtime/secrets

**Note:** `Bun.secrets` is for local dev tools. For production, use a real secrets manager (Vault, AWS Secrets Manager). The doc explicitly says "Not very useful for deployment secrets."

---

## C. Real-Time Updates (WebSocket)

### C1. WebSocket server for live progress streaming

**Current:** Worker sends progress via IPC → pool logs to console. No way to push updates to a connected client.

**Doc pattern:**
```ts
Bun.serve({
  fetch(req, server) {
    if (server.upgrade(req, { data: { agentId, taskId } })) return;
  },
  websocket: {
    data: {} as { agentId: number; taskId: number },
    open(ws) { ws.subscribe(`task:${ws.data.taskId}`); },
    message(ws, msg) { /* client commands */ },
    close(ws) { ws.unsubscribe(`task:${ws.data.taskId}`); },
  },
});
```
Bun's WebSocket is built on uWebSockets — 7x more throughput than Node + `ws`. Native pub/sub via `ws.subscribe(topic)` / `server.publish(topic, msg)`.

**Action:**
1. Add `websocket` handler to `Bun.serve` in server.ts
2. Upgrade `/ws/task/:id` connections, attach `{ taskId }` as `ws.data`
3. In `pool.ts`, when receiving progress IPC messages, call `server.publish(`task:${taskId}`, JSON.stringify({ progress }))` instead of (or in addition to) console.log
4. Client subscribes and receives real-time progress updates

**Ref:** https://bun.com/docs/runtime/http/websockets

### C2. WebSocket for live control (remote browser viewing)

**Doc pattern:** `Bun.WebView.screenshot()` returns `ArrayBuffer`. Stream via `ws.send(arrayBuffer)` — Bun's WebSocket supports `ArrayBuffer`, `Uint8Array`, `Blob`, `string` directly.

**Action:** When `Bun.WebView` is integrated (see D1), add a `/ws/control/:taskId` endpoint that streams screenshots at intervals. Worker captures screenshots and sends them via IPC → server publishes to the WebSocket topic.

---

## D. Browser Automation (Bun.WebView)

### D1. Replace stub with `Bun.WebView`

**Current:** `task-worker.ts:116-146` generates a synthetic 1280x720 PNG with a manual PNG encoder. The `executeTask()` function simulates work with `setTimeout(500)` per step.

**Doc pattern:**
```ts
await using view = new Bun.WebView({ width: 1280, height: 720 });
await view.navigate("https://example.com");
await view.click("a[href]");
const title = await view.evaluate("document.title");
const screenshot = await view.screenshot(); // ArrayBuffer
// view.close() called automatically via `await using`
```

Key API surface from docs:
- `new Bun.WebView({ width, height, url, backend, dataStore })`
- `view.navigate(url)` — async, waits for load
- `view.click(selector)` — waits for element to be clickable, dispatches native `isTrusted: true` events
- `view.type(selector, text)` — input simulation
- `view.evaluate(js)` — run JS in page context
- `view.screenshot()` — returns ArrayBuffer
- `view.close()` — or use `await using` for automatic cleanup
- `dataStore: { directory: "./profile" }` — persistent cookies/localStorage across runs
- `backend: "webkit"` (macOS default, zero deps) or `backend: "chrome"` (Linux/Windows)

**Action:**
1. Replace `generatePlaceholderScreenshot()` with `await view.screenshot()`
2. Replace simulated steps with real WebView operations: `navigate(task.url)`, `click()`, `evaluate()`, `screenshot()`
3. Use `dataStore: { directory: ./data/profiles/{agent_id} }` for persistent sessions
4. Pass the screenshot `ArrayBuffer` directly to `processScreenshot()` (Bun.Image accepts ArrayBuffer)
5. Use `await using view` for automatic cleanup on task completion or error

**Ref:** https://bun.com/docs/runtime/webview

### D2. Session persistence across tasks

**Current:** `sessions` table has `cookies`, `local_storage`, `session_storage` columns but they're never populated (default `'{}'`).

**Doc pattern:** `Bun.WebView({ dataStore: { directory: "./browser-profile" } })` — views sharing the same directory share cookies and storage. Persistent across runs.

**Action:** Use per-agent profile directories. After task completion, extract cookies via `view.evaluate("document.cookie")` and store in the `sessions` table. On next task for the same agent+site, reuse the profile directory to skip login.

---

## E. Scheduling (Bun.cron)

### E1. Scheduled data collection

**Current:** No scheduling. Tasks are created manually via POST `/task`.

**Doc pattern:**
```ts
Bun.cron("0 * * * *", async () => {
  // Runs every hour
  await collectData();
});

// Parse next run time
const next = Bun.cron.parse("30 9 * * MON-FRI");

// OS-level job that survives restarts
await Bun.cron("./worker.ts", "30 2 * * MON", "weekly-report");
```

**Action:**
1. Add a `schedules` table (cron expression, agent_id, url, task template)
2. On server boot, register all schedules via `Bun.cron()`
3. Add `POST /schedule` endpoint to create new schedules
4. When cron fires, insert a task and submit to worker pool
5. Use `Bun.cron.parse()` to show next run time in API responses

**Ref:** https://bun.com/docs/runtime/cron

---

## F. Frontend (HTML Imports)

### F1. Dashboard via HTML imports

**Current:** No frontend. API-only.

**Doc pattern (CLAUDE.md + Server docs):**
```ts
import index from "./index.html";

Bun.serve({
  routes: {
    "/": index,
    "/api/tasks": () => Response.json({ tasks: [] }),
  },
  development: { hmr: true, console: true },
});
```
HTML imports run Bun's bundler — supports React, TypeScript, Tailwind CSS. Dev mode (`bun --hot`) gives HMR without full page reloads. Production (`bun build --target=bun`) pre-bundles all assets.

**Action:**
1. Create `src/dashboard/index.html` with React + Tailwind
2. Create `src/dashboard/frontend.tsx` — task list, progress bars, screenshot viewer
3. Add `"/": index` route to server.ts
4. WebSocket client in frontend connects to `/ws/task/:id` for live progress
5. Screenshot viewer uses `<img src="/screenshot/:id">` with blur-up placeholder from thumbhash

**Ref:** https://bun.com/docs/runtime/http/server (HTML imports section), CLAUDE.md

---

## G. Observability

### G1. Structured logging

**Current:** `console.log("[server] ...")` everywhere. No levels, no structured output, no log routing.

**Action:** Create `src/utils/logger.ts` with levels (debug/info/warn/error), structured JSON output, and optional file transport. Replace all `console.log`/`console.error` calls.

### G2. Per-request traceId

**Current:** No request tracing.

**Action:** Generate a `traceId` per request (UUID), attach to all log entries, propagate to workers via IPC. Add `X-Trace-Id` response header.

---

## H. Testing

### H1. Unit tests for core modules

**Current:** Zero tests. `bun run test` finds nothing.

**Doc pattern (CLAUDE.md):**
```ts
import { test, expect } from "bun:test";

test("rate limit allows up to max", () => {
  expect(checkRateLimit("1.2.3.4", "/login").allowed).toBe(true);
});
```

**Action:** Create `src/**/*.test.ts` files:
- `src/db/index.test.ts` — migrate, read, write, concurrent writes
- `src/middleware/rate-limit.test.ts` — checkRateLimit, cleanupRateLimits
- `src/middleware/cors.test.ts` — isAllowedOrigin, handlePreflight
- `src/utils/retry.test.ts` — withRetry, computeDelay, jitter
- `src/utils/circuit-breaker.test.ts` — recordFailure, recordSuccess, isAllowed
- `src/utils/image.test.ts` — processScreenshot, serveScreenshot

**Ref:** https://bun.com/docs/test (Bun test runner)

---

## I. v1.3.14 Feature Adoption

### I1. `--no-orphans` for worker processes

**Release note:** `--no-orphans` flag exits child processes when the parent dies. Prevents zombie workers if the main server crashes.

**Action:** Add `--no-orphans` to the worker spawn command in `pool.ts`, or set it via `BUN_OPTIONS` env. Currently we strip `BUN_OPTIONS` — need to selectively pass `--no-orphans`.

**Ref:** v1.3.14 blog — "## `--no-orphans`"

### I2. `process.execve()` for zero-overhead worker restart

**Release note:** `process.execve()` replaces the current process image without fork+exec. Faster than spawning a new process.

**Action:** In worker respawn logic (`pool.ts:106`), consider `process.execve()` in the worker instead of spawning a new process from the parent. Reduces respawn overhead from ~50ms to near-zero.

**Ref:** v1.3.14 blog — "## `process.execve()` support"

### I3. HTTP/3 (QUIC) support

**Release note:** `Bun.serve({ tls: {...}, http3: true })` — experimental HTTP/3 over QUIC.

**Action:** When TLS is configured, enable `http3: true`. Clients with HTTP/3 support get lower latency. Requires TLS certs.

**Ref:** https://bun.com/docs/runtime/http/server (HTTP/3 section)

### I4. `using` / `await using` for resource cleanup

**Release note:** v1.3.14 no longer lowers `using`/`await using` when targeting Bun. Native disposal semantics.

**Action:** Use `await using view = new Bun.WebView(...)` in task-worker.ts for automatic cleanup. Use `using` for database connections where appropriate.

**Ref:** v1.3.14 blog — "## `using` / `await using` no longer lowered"

---

## Priority Order

| Phase | Task | Effort | Impact |
|-------|------|--------|--------|
| 1 | A1: Migrate to `routes` property | Medium | Code quality + perf |
| 1 | A2: Fix `require()` in ESM | Trivial | Code quality |
| 1 | A3: Fix rate limit TOCTOU | Small | Correctness |
| 1 | A4: Remove `as any` cast | Trivial | Type safety |
| 2 | B1: Auth middleware | Medium | Critical security |
| 2 | B2: CSRF protection | Small | Critical security |
| 3 | D1: Bun.WebView integration | Large | Core functionality |
| 3 | D2: Session persistence | Medium | Core functionality |
| 4 | C1: WebSocket progress streaming | Medium | Real-time UX |
| 4 | C2: WebSocket live control | Medium | Real-time UX |
| 5 | H1: Unit tests | Medium | Reliability |
| 5 | G1: Structured logging | Small | Observability |
| 5 | G2: TraceId propagation | Small | Observability |
| 6 | E1: Bun.cron scheduling | Medium | Automation |
| 6 | F1: Dashboard via HTML imports | Large | UX |
| 7 | B3: Bun.secrets for credentials | Medium | Security |
| 7 | I1: `--no-orphans` | Trivial | Reliability |
| 7 | I2: `process.execve()` restart | Small | Performance |
| 7 | I3: HTTP/3 support | Small | Performance |
| 7 | I4: `using` for cleanup | Trivial | Code quality |
