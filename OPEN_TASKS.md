# Open Tasks — Grounded in Bun v1.3.14 Docs & Release Notes

Cross-referenced against:
- [Bun v1.3.14 release blog](https://bun.com/blog/bun-v1.3.14) — released May 13, 2026
- [Bun docs](https://bun.com/docs/) — Server, Routing, WebSockets, WebView, Cron, CSRF, Secrets, Spawn, Image
  - [Cron (canonical)](https://bun.com/docs/runtime/cron) — `Bun.cron()`, `Bun.cron.parse()`, OS-level jobs
- Current codebase (`src/` — 12 files, ~1600 lines)
- `BACKLOG.md` gap analysis

Each task cites the specific Bun API/doc that grounds it.

---

## A. Code Quality Fixes (existing code, no new features)

### A1. Migrate to `routes` property (Bun.serve docs — Routing)

**Current:** `src/server.ts` uses manual `path.match(/^\/task\/(\d+)$/)` regex matching inside a single `fetch()` handler. 326 lines of if/else chains.

**Doc pattern:** `Bun.serve({ routes: { "/task/:id": req => ..., "/users/:id": req => ... } })` — Bun's router does SIMD-accelerated param decoding, type-safe `req.params`, and static response caching. Per-method handlers (`GET`, `POST`) are supported natively.

**Action:** Rewrite server.ts to use the `routes` object. Eliminates all regex matching, gives type-safe params, and improves dispatch performance.

**Ref:** https://bun.com/docs/runtime/http/routing

### A2. Fix `require()` calls in ESM context (task-worker.ts:160,192) — [RESOLVED ✅]

**Current:** Replaced `require("node:zlib")` with Bun native APIs: `Bun.deflateSync`, `Bun.hash.adler32`, and `Bun.hash.crc32`. Zero Node.js dependencies.

### A3. Fix rate limit TOCTOU race (rate-limit.ts:50-67) — [RESOLVED ✅]

**Current:** Merged check and increment into a single atomic SQLite query: `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count;`.

### A4. Remove `as any` cast in image.ts:122 — [RESOLVED ✅]

**Current:** `img.resize(width, width, { fit: "inside" })` is now properly typed without `as any`.

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

**Ref:** [v1.3.14 blog — `--no-orphans`](https://bun.com/blog/bun-v1.3.14#no-orphans-exit-when-the-parent-process-dies)

### I2. `process.execve()` for zero-overhead worker restart

**Release note:** `process.execve()` replaces the current process image without fork+exec. Faster than spawning a new process.

**Action:** In worker respawn logic (`pool.ts:106`), consider `process.execve()` in the worker instead of spawning a new process from the parent. Reduces respawn overhead from ~50ms to near-zero.

**Ref:** [v1.3.14 blog — `process.execve()` support](https://bun.com/blog/bun-v1.3.14#process-execve-support)

### I3. HTTP/3 (QUIC) support

**Release note:** `Bun.serve({ tls: {...}, http3: true })` — experimental HTTP/3 over QUIC.

**Action:** When TLS is configured, enable `http3: true`. Clients with HTTP/3 support get lower latency. Requires TLS certs.

**Ref:** [v1.3.14 blog — HTTP/3 (QUIC) support in `Bun.serve`](https://bun.com/blog/bun-v1.3.14#http-3-quic-support-in-bun-serve) · [Server docs](https://bun.com/docs/runtime/http/server)

### I4. `using` / `await using` for resource cleanup

**Release note:** v1.3.14 no longer transpiles `using`/`await using` into `__using` / `__callDispose` helper calls wrapped in `try`/`catch`/`finally` when the target is Bun. Bun's JavaScriptCore engine natively supports the [Explicit Resource Management proposal](https://github.com/tc39/proposal-explicit-resource-management) (`Symbol.dispose` / `Symbol.asyncDispose`).

**Applies to:**
- `bun run` / `bun <file>`
- `Bun.Transpiler({ target: "bun" })`
- `bun build --target=bun` (including `--compile` and `--bytecode`)

Other targets (`browser`, `node`) continue to lower `using` as before.

**Bug fix included:** `using` inside a CommonJS module (`.cjs`) previously injected an ESM `import … from "bun:wrap"` inside the CommonJS function wrapper, causing an `Expected CommonJS module to have a function wrapper` error. Now fixed — non-disposable values correctly throw `TypeError`.

**Why this matters:**
- **Smaller bundles** — no `__using` / `__callDispose` helper functions injected into output
- **Cleaner stack traces** — no `__callDispose` frames in debug output when disposal throws
- **Better performance** — native JavaScriptCore disposal is faster than transpiled `try`/`catch`/`finally` fallbacks

**Before** (lowered):
```ts
var __using = (stack, value, async) => { /* ... */ };
var __callDispose = (stack, error, hasError) => { /* ... */ };
{
  let __stack = [];
  try {
    const x = __using(__stack, { [Symbol.dispose]() { /* ... */ } }, 0);
    console.log("hi");
  } catch (_catch) {
    var _err = _catch, _hasErr = 1;
  } finally {
    __callDispose(__stack, _err, _hasErr);
  }
}
```

**After** (native):
```ts
{
  using x = { [Symbol.dispose]() { /* ... */ } };
  console.log("hi");
}
```

**Action:**
1. Use `await using view = new Bun.WebView(...)` in task-worker.ts for automatic cleanup on scope exit (no manual `view.close()` needed)
2. Use `using` for database connections / file handles where appropriate
3. Verify `bun build --target=bun --compile` (used for the 61MB standalone executable) now produces smaller output — no `__using`/`__callDispose` helpers emitted
4. If any `.cjs` files use `using`, confirm they no longer throw the wrapper error

**Ref:** [v1.3.14 blog — `using` / `await using` no longer lowered](https://bun.com/blog/bun-v1.3.14#using-await-using-no-longer-lowered-when-targeting-bun) · [TC39 proposal](https://github.com/tc39/proposal-explicit-resource-management)

---

## Priority Order

> **Est. Time** = focused implementation time for a developer familiar with Bun and this codebase, excluding PR review cycles. Units: `min` / `hr` / `hrs` / `day` (1 day = 8 working hours). These estimates inform the Bun.cron schedules and task prioritisation (higher priority = shorter SLA).

| Phase | Task | Effort | Impact | Est. Time | Difficulty | Rate |
|-------|------|--------|--------|-----------|------------|------|
| 1 | A1: Migrate to `routes` property | Medium | Code quality + perf | ~1 hr | Medium | ★★★★☆ |
| 1 | A2: Fix `require()` in ESM | Trivial | Code quality | ~5 min | Easy | ★★★☆☆ |
| 1 | A3: Fix rate limit TOCTOU | Small | Correctness | ~15 min | Easy | ★★★★★ |
| 1 | A4: Remove `as any` cast | Trivial | Type safety | ~5 min | Easy | ★★★☆☆ |
| 2 | B1: Auth middleware | Medium | Critical security | ~2 hrs | Medium | ★★★★★ |
| 2 | B2: CSRF protection | Small | Critical security | ~45 min | Easy | ★★★★★ |
| 3 | D1: Bun.WebView integration | Large | Core functionality | ~1 day | Hard | ★★★★★ |
| 3 | D2: Session persistence | Medium | Core functionality | ~3 hrs | Medium | ★★★★☆ |
| 4 | C1: WebSocket progress streaming | Medium | Real-time UX | ~2 hrs | Medium | ★★★★☆ |
| 4 | C2: WebSocket live control | Medium | Real-time UX | ~3 hrs | Medium | ★★★☆☆ |
| 5 | H1: Unit tests | Medium | Reliability | ~4 hrs | Medium | ★★★★☆ |
| 5 | G1: Structured logging | Small | Observability | ~1 hr | Easy | ★★★☆☆ |
| 5 | G2: TraceId propagation | Small | Observability | ~30 min | Easy | ★★★☆☆ |
| 6 | E1: Bun.cron scheduling | Medium | Automation | ~2 hrs | Medium | ★★★☆☆ |
| 6 | F1: Dashboard via HTML imports | Large | UX | ~1 day | Hard | ★★★☆☆ |
| 7 | B3: Bun.secrets for credentials | Medium | Security | ~3 hrs | Medium | ★★★☆☆ |
| 7 | I1: `--no-orphans` | Trivial | Reliability | ~5 min | Easy | ★★☆☆☆ |
| 7 | I2: `process.execve()` restart | Small | Performance | ~30 min | Easy | ★★☆☆☆ |
| 7 | I3: HTTP/3 support | Small | Performance | ~1 hr | Easy | ★★☆☆☆ |
| 7 | I4: `using` for cleanup | Trivial | Code quality | ~15 min | Easy | ★★☆☆☆ |

---

## Appendix: `Bun.cron` — Deep Reference

> **Introduced in [Bun v1.3.11](https://bun.com/blog/bun-v1.3.11)** (March 18, 2026) · Canonical docs: [bun.com/docs/runtime/cron](https://bun.com/docs/runtime/cron)
>
> All claims below verified against the canonical docs page (fetched Aug 14, 2026). Section anchors link to the specific docs section.

`Bun.cron` is a built-in cron scheduling API. It provides two distinct scheduling modes:

---

### 1. In-Process Scheduling ([`Bun.cron(schedule, handler)`](https://bun.com/docs/runtime/cron#bun-cron-schedule-handler-in-process))

Runs a callback inside your current process on a cron schedule.

```ts
const job = Bun.cron("*/5 * * * *", async () => {
  await syncToDatabase();
});
```

**Key characteristics**:

| Property | Behaviour |
|----------|-----------|
| **State sharing** | Shares database pools, caches, and module-level variables between invocations |
| **Survives restarts** | No — stops when process exits |
| **Platform requirements** | None — works identically on all platforms |
| **No-overlap guarantee** | Next fire is scheduled **after** the handler settles — invocations never stack |
| **Return type** | `CronJob` handle |

**[Error handling](https://bun.com/docs/runtime/cron#error-handling)**:
- Synchronous `throw` → `process.on("uncaughtException")`
- Rejected `Promise` → `process.on("unhandledRejection")`
- Without a listener, process exits with code `1`. With a listener, the job **continues** — it does not stop on first failure.

**[`CronJob` handle](https://bun.com/docs/runtime/cron#the-cronjob-handle)**:

```ts
using job = Bun.cron("0 * * * *", () => {});
job.cron;        // => "0 * * * *"
job.stop();      // cancel — handler will not fire again
job.unref();     // allow process to exit even while scheduled
job.ref();       // keep process alive (default)
```

`CronJob` implements [`Disposable`](https://bun.com/docs/runtime/cron#the-cronjob-handle) (`Symbol.dispose`) — `using job = Bun.cron(...)` auto-stops at scope exit. `stop()`, `ref()`, and `unref()` all return the job for chaining.

**[Time zone](https://bun.com/docs/runtime/cron#time-zone)**:
- Default: system's local time zone
- Override with `{ tz: "America/New_York" }` option
- DST transitions are handled to match crontab behaviour

**[Fake timers](https://bun.com/docs/runtime/cron#fake-timers)** — in-process cron honours `jest.useFakeTimers()`. `setSystemTime()`, `advanceTimersByTime()`, and `runAllTimers()` control when it fires.

**[`bun --hot`](https://bun.com/docs/runtime/cron#bun-hot)** — all in-process cron jobs are stopped immediately before module graph re-evaluates; `Bun.cron()` calls re-register on save without leaking timers.

---

### 2. OS-Level Scheduling ([`Bun.cron(path, schedule, title)`](https://bun.com/docs/runtime/cron#bun-cron-path-schedule-title-os-level))

Registers a persistent cron job with the operating system that survives process restarts.

```ts
await Bun.cron("./worker.ts", "30 2 * * MON", "weekly-report");
```

**Key characteristics**:

| Property | Behaviour |
|----------|-----------|
| **State sharing** | No — fresh process each run |
| **Survives restarts** | Yes — registered with OS scheduler |
| **Platform backend** | Linux: [crontab](https://bun.com/docs/runtime/cron#linux), macOS: [launchd](https://bun.com/docs/runtime/cron#macos), Windows: [Task Scheduler](https://bun.com/docs/runtime/cron#windows) |

**Re-registration** — calling with the same `title` overwrites the existing job in-place.

**[The `scheduled()` handler](https://bun.com/docs/runtime/cron#the-scheduled-handler)** — worker script must export a default object with a `scheduled()` method (Cloudflare Workers Cron Triggers API):

```ts
// worker.ts
export default {
  scheduled(controller: Bun.CronController) {
    console.log(controller.cron);          // "30 2 * * 1"
    console.log(controller.type);          // "scheduled"
    console.log(controller.scheduledTime); // 1737340201847 (Date.now() at invocation)
  },
};
```

**[Platform backends](https://bun.com/docs/runtime/cron#how-it-works-per-platform)**:

| Platform | Backend | Logs |
|----------|---------|------|
| Linux | crontab (`# bun-cron: <title>` marker) | `journalctl -u cron` (or `grep CRON /var/log/syslog` on older systems) |
| macOS | launchd plist at `~/Library/LaunchAgents/bun.cron.<title>.plist` | `/tmp/bun.cron.<title>.stdout.log` and `.stderr.log` |
| Windows | Task Scheduler (`bun-cron-<title>`, `CalendarTrigger` + `Repetition`) | ⚠️ Not specified in Bun docs; Task Scheduler typically logs to Event Viewer |

**[Windows limitations](https://bun.com/docs/runtime/cron#trigger-limit)**:
- Task Scheduler enforces **48 triggers per task** maximum (`CalendarTrigger` `maxOccurs="48"`)
- Minute steps that **don't divide 60** (`*/7`, `*/8`, `*/9`, `*/11`, `*/13`, etc.) must expand to individual triggers and may exceed this limit (e.g. `*/7` = 216 triggers)
- Steps that divide 60 (`*/1`, `*/2`, `*/3`, `*/4`, `*/5`, `*/6`, `*/10`, `*/12`, `*/15`, `*/20`, `*/30`) use `Repetition` (single trigger) and work regardless of other fields
- **[Not supported](https://bun.com/docs/runtime/cron#windows-containers) in Windows Docker containers** — Task Scheduler service is not running in `servercore` or `nanoserver` images

---

### 3. Expression Parsing ([`Bun.cron.parse()`](https://bun.com/docs/runtime/cron#bun-cron-parse))

Parse a cron expression and return the next matching `Date`.

```ts
const next = Bun.cron.parse("*/15 * * * *");
console.log(next); // => next quarter-hour boundary
```

**Parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| `expression` | `string` | 5-field cron expression or predefined nickname |
| `relativeDate` | `Date \| number` | Starting point (defaults to `Date.now()`) |
| `options` | `{ tz?: string }` | IANA time-zone name (defaults to system zone) |

**Returns**: `Date | null` — `null` if no match exists within 8 years.

**Chaining calls**:

```ts
let cursor = Date.now();
for (let i = 0; i < 3; i++) {
  cursor = Bun.cron.parse("0 * * * *", cursor)!;
  console.log(cursor.toLocaleString()); // next three top-of-hour boundaries
}
```

---

### 4. [Cron Expression Syntax](https://bun.com/docs/runtime/cron#cron-expression-syntax)

**Standard 5-field format**: `minute hour day-of-month month day-of-week`

| Field | Values | Special chars |
|-------|--------|---------------|
| Minute | `0`–`59` | `*`, `,`, `-`, `/` |
| Hour | `0`–`23` | `*`, `,`, `-`, `/` |
| Day of month | `1`–`31` | `*`, `,`, `-`, `/` |
| Month | `1`–`12` or `JAN`–`DEC` | `*`, `,`, `-`, `/` |
| Day of week | `0`–`7` or `SUN`–`SAT` | `*`, `,`, `-`, `/` |

**Special characters**:

| Character | Description | Example |
|-----------|-------------|---------|
| `*` | All values | `* * * * *` — every minute |
| `,` | List | `1,15 * * * *` — minute 1 and 15 |
| `-` | Range | `9-17 * * * *` — minutes 9 through 17 |
| `/` | Step | `*/15 * * * *` — every 15 minutes |

**[Named values](https://bun.com/docs/runtime/cron#named-values)** — case-insensitive month and weekday names:

```ts
Bun.cron.parse("0 9 * * MON-FRI");        // weekdays
Bun.cron.parse("0 9 * * Monday-Friday");  // full names
Bun.cron.parse("0 0 1 JAN,JUN *");        // January and June
```

**[Predefined nicknames](https://bun.com/docs/runtime/cron#predefined-nicknames)**:

| Nickname | Equivalent | Description |
|----------|------------|-------------|
| `@yearly` / `@annually` | `0 0 1 1 *` | Once a year |
| `@monthly` | `0 0 1 * *` | Once a month |
| `@weekly` | `0 0 * * 0` | Once a week |
| `@daily` / `@midnight` | `0 0 * * *` | Once a day |
| `@hourly` | `0 * * * *` | Once an hour |

**[POSIX OR logic](https://bun.com/docs/runtime/cron#day-of-month-and-day-of-week-interaction)** — when both day-of-month and day-of-week are specified (neither is `*`), the expression matches when **either** condition is true.

**Sunday as `7`** — weekday field accepts both `0` and `7`.

---

### 5. Removal ([`Bun.cron.remove()`](https://bun.com/docs/runtime/cron#bun-cron-remove))

Remove a previously registered OS-level cron job by its title.

```ts
await Bun.cron.remove("weekly-report");
```

Works across all platforms — removes the crontab entry, launchd plist, or Task Scheduler task.

---

### 6. Integration Points in the Automation Platform

| Use Case | Mode | Schedule | Why |
|----------|------|----------|-----|
| **Session health checks** | In-process | `*/5 * * * *` | Shares DB connection pool, lightweight API calls |
| **Session refresh on expiry** | In-process (spawns worker) | Triggered by health check failure | Shares state with main server |
| **Heavy data collection** | OS-level | `0 */2 * * *` | Survives server restarts; runs independent of main process |
| **Cleanup jobs** | In-process | `0 3 * * *` | Low-frequency, shares DB state |

**Key advantage**: In-process mode shares database pools and caches, while OS-level mode provides persistence across restarts.

---

## Appendix: `Bun.markdown` — Deep Reference

> Grounded in [Bun Markdown docs](https://bun.com/docs/runtime/markdown) (covers `html`, `render`, `react` only), [API reference](https://bun.com/reference/bun/markdown) (all four functions), [v1.3.8 blog](https://bun.com/blog/bun-v1.3.8) (introduction), and [v1.3.12 blog](https://bun.com/blog/bun-v1.3.12) (`ansi()` + `bun ./file.md` CLI).
>
> **Stability: Unstable** — "This API is under active development and may change in future versions of Bun."
>
> **Version history:** `html`/`render`/`react` introduced v1.3.8 · `ansi()` + `bun ./file.md` CLI added v1.3.12 · v1.3.14 fixed `ansi()` crash on invalid UTF-8 (lone continuation bytes `0x80-0xBF`, bytes `0xF8-0xFF` now treated as replacement characters).

### 1. Four Render Functions

| Function | Signature | Returns | Use Case |
|----------|-----------|---------|----------|
| `Bun.markdown.html()` | `html(input, options?)` | `string` | Render to HTML string |
| `Bun.markdown.render()` | `render(input, callbacks?, options?)` | `string` | Custom callbacks per element (ANSI, custom HTML, plain text) |
| `Bun.markdown.react()` | `react(input, components?, options?)` | `unknown` (React Fragment) | React JSX elements; SSR via `renderToString()` |
| `Bun.markdown.ansi()` | `ansi(input, theme?)` | `string` | ANSI-colored terminal output; enables all GFM + wikilinks + underline + LaTeX math by default. **v1.3.12+** |

**Input type:** `string | ArrayBufferLike | TypedArray | DataView`

**CLI:** `bun ./file.md` (v1.3.12+) — renders a Markdown file directly to formatted ANSI terminal output with zero JS VM startup overhead. Uses `ansi()` internally.

```ts
// html() — simplest
const html = Bun.markdown.html("# Hello **world**");
// "<h1>Hello <strong>world</strong></h1>\n"

// render() — custom callbacks (ANSI example)
const ansi = Bun.markdown.render("# Hello\n\n**bold**", {
  heading: (children) => `\x1b[1;4m${children}\x1b[0m\n`,
  paragraph: (children) => children + "\n",
  strong: (children) => `\x1b[1m${children}\x1b[22m`,
});

// react() — React component
function Markdown({ text }: { text: string }) {
  return Bun.markdown.react(text);
}
// SSR
import { renderToString } from "react-dom/server";
const html = renderToString(Bun.markdown.react("# Hello **world**"));

// ansi() — terminal output with theme
const out = Bun.markdown.ansi("# Hello\n\n**bold** and *italic*\n");
process.stdout.write(out);
// Plain text (no escape codes)
const plain = Bun.markdown.ansi("# Hello", { colors: false });
// OSC 8 clickable hyperlinks
const linked = Bun.markdown.ansi("[docs](https://bun.com)", { hyperlinks: true });
```

### 2. Options (Parser Configuration)

`html`, `render`, and `react` accept `Options` (html: 2nd arg; render: 3rd arg; react: 3rd arg as `ReactOptions`). `ansi()` uses `AnsiTheme` instead (see [AnsiTheme](#6-ansitheme-ansi-second-argument) below).

**GFM extensions — enabled by default:**

| Option | Default | Description |
|--------|---------|-------------|
| `tables` | `true` | GFM tables |
| `strikethrough` | `true` | GFM strikethrough (`~~text~~`) |
| `tasklists` | `true` | GFM task lists (`- [x] item`) |

**Additional options — all default `false`:**

| Option | Type | Description |
|--------|------|-------------|
| `autolinks` | `boolean \| { url: boolean, www: boolean, email: boolean }` | Autolink URLs, emails, www links. `true` = all types |
| `headings` | `boolean \| { ids: boolean, autolink: boolean }` | Heading IDs and autolink headings. `true` = both |
| `hardSoftBreaks` | `boolean` | Treat soft line breaks as hard breaks (`<br>`) |
| `wikiLinks` | `boolean` | Enable `[[wiki links]]` and `[[target\|label]]` |
| `underline` | `boolean` | `__text__` renders as `<u>` instead of `<strong>` |
| `latexMath` | `boolean` | Enable `$inline$` and `$$display$$` math |
| `collapseWhitespace` | `boolean` | Collapse whitespace in text content |
| `permissiveAtxHeaders` | `boolean` | ATX headers without space after `#` |
| `noIndentedCodeBlocks` | `boolean` | Disable indented code blocks |
| `noHtmlBlocks` | `boolean` | Disable HTML blocks |
| `noHtmlSpans` | `boolean` | Disable inline HTML spans |
| `tagFilter` | `boolean` | GFM tag filter — replaces `<` with `&lt;` for disallowed HTML tags (`<script>`, `<style>`, `<iframe>`) |

#### Autolinks (detailed)

```ts
// Enable all autolink types (URL, WWW, email)
Bun.markdown.html("Visit www.example.com or email test@example.com", {
  autolinks: true,
});

// Granular control — only URL and www
Bun.markdown.html("Visit www.example.com", {
  autolinks: { url: true, www: true }, // email: false (default)
});
```

#### Heading IDs (detailed)

```ts
// Enable both heading IDs and autolink headings
Bun.markdown.html("## Hello World", { headings: true });
// '<h2 id="hello-world"><a href="#hello-world">Hello World</a></h2>\n'

// Enable only heading IDs (no autolink)
Bun.markdown.html("## Hello World", { headings: { ids: true } });
// '<h2 id="hello-world">Hello World</h2>\n'
```

### 3. Meta Interfaces (passed to `render()` callbacks)

Each callback receives `(children: string, meta?: MetaInterface)`. Return `string` to replace output, `null`/`undefined` to omit element.

| Interface | Fields | Used by callback |
|-----------|--------|-----------------|
| `ListMeta` | `depth: number`, `ordered: boolean`, `start?: number` | `list` |
| `ListItemMeta` | `index: number`, `depth: number`, `ordered: boolean`, `start?: number`, `checked?: boolean` | `listItem` |
| `HeadingMeta` | `level: number` (1–6), `id?: string` | `heading` |
| `CodeBlockMeta` | `language?: string` | `code` |
| `CellMeta` | `align?: 'left' \| 'center' \| 'right'` | `th`, `td` |
| `LinkMeta` | `href: string`, `title?: string` | `link` |
| `ImageMeta` | `src: string`, `title?: string` | `image` |

### 4. Render Callbacks (`render()` second argument)

Return `string` to replace output, `null`/`undefined` to omit element. If no callback is registered, children pass through unchanged. **21 callbacks total** (14 block + 7 inline).

**Block callbacks:**

| Callback | Meta | Description |
|----------|------|-------------|
| `heading` | `HeadingMeta` `{ level, id? }` | Heading level 1–6. `id` set when `headings: { ids: true }`. |
| `paragraph` | — | Paragraph block |
| `blockquote` | — | Blockquote block |
| `code` | `CodeBlockMeta` `{ language? }` | Fenced/indented code block. `language` is info-string (e.g. `"js"`). Only passed for fenced code blocks with a language. |
| `list` | `ListMeta` `{ ordered, start?, depth }` | Ordered or unordered list. `start` is first item number for ordered lists. |
| `listItem` | `ListItemMeta` `{ index, depth, ordered, start?, checked? }` | List item. `meta` always includes `{index, depth, ordered}`. `start` set for ordered lists; `checked` set for task list items. |
| `hr` | — | Horizontal rule |
| `table` | — | Table block |
| `thead` | — | Table head |
| `tbody` | — | Table body |
| `tr` | — | Table row |
| `th` | `CellMeta` `{ align? }` | Table header cell. `align` is `"left"`, `"center"`, `"right"`, or absent. |
| `td` | `CellMeta` `{ align? }` | Table data cell. `align` set when column alignment specified. |
| `html` | — | Raw HTML content |

**Inline callbacks:**

| Callback | Meta | Description |
|----------|------|-------------|
| `strong` | — | Strong emphasis (`**text**`) |
| `emphasis` | — | Emphasis (`*text*`) |
| `strikethrough` | — | Strikethrough (`~~text~~`) |
| `link` | `LinkMeta` `{ href, title? }` | Link. `href` is URL, `title` is optional title attribute. |
| `image` | `ImageMeta` `{ src, title? }` | Image. `src` is URL, `title` is optional title attribute. |
| `codespan` | — | Inline code (`` `code` ``) |
| `text` | — | Plain text content. **Note:** receives `text` directly (not `children`). |

#### List item meta (detailed)

The `listItem` callback receives everything needed to render markers directly — no post-processing:
- `index` — 0-based position within the parent list
- `depth` — the parent list's nesting level (0 = top-level)
- `ordered` — whether the parent list is ordered
- `start` — the parent list's start number (only when `ordered` is true)
- `checked` — task list state (only for `- [x]` / `- [ ]` items)

#### Examples

```ts
// render() with parser options as third argument
const linked = Bun.markdown.render("Visit www.example.com", {
  link: (children, { href }) => `[${children}](${href})`,
  paragraph: (children) => children,
}, { autolinks: true });

// Stripping all formatting (plain text extraction)
const plaintext = Bun.markdown.render("# Hello **world**", {
  heading: children => children,
  paragraph: children => children,
  strong: children => children,
  emphasis: children => children,
  link: children => children,
  image: () => "",
  code: children => children,
  codespan: children => children,
});
// "Hello world"

// Omitting elements (return null/undefined to remove)
const omitted = Bun.markdown.render("# Title\n\n![logo](img.png)\n\nHello", {
  image: () => null, // Remove all images
  heading: children => children,
  paragraph: children => children + "\n",
});
// "Title\nHello\n"

// Nested list numbering — listItem meta gives everything needed
// (toRoman is a user-supplied helper, e.g. 4 → "iv")
const nested = Bun.markdown.render("1. first\n   1. sub-a\n   2. sub-b\n2. second", {
  listItem: (children, { index, depth, ordered, start }) => {
    const n = (start ?? 1) + index;
    const marker = !ordered
      ? "-"
      : depth === 0
        ? `${n}.`
        : depth === 1
          ? `${String.fromCharCode(96 + n)}.`
          : `${toRoman(n)}.`;
    return "  ".repeat(depth) + marker + " " + children.trimEnd() + "\n";
  },
  list: children => "\n" + children, // prepend newline for nested list separation
});
// 1. first
//   a. sub-a
//   b. sub-b
// 2. second

// Code block syntax highlighting
const highlighted = Bun.markdown.render("```js\nconsole.log('hi')\n```", {
  code: (children, meta) => {
    const lang = meta?.language ?? "";
    return `<pre><code class="language-${lang}">${children}</code></pre>`;
  },
});
```

### 5. React Component Overrides (`react()` second argument)

Every HTML tag can be overridden with a custom React component:

| Override | Props | Description |
|----------|-------|-------------|
| `h1`–`h6` | `{ id?, children }` | Headings (`id` when `headings: { ids: true }`) |
| `p` | `{ children }` | Paragraph |
| `blockquote` | `{ children }` | Blockquote |
| `pre` | `{ language?, children }` | Code block |
| `hr` | `{}` | Horizontal rule (no children) |
| `ul` | `{ children }` | Unordered list |
| `ol` | `{ start, children }` | Ordered list |
| `li` | `{ checked?, children }` | List item (`checked` for task lists) |
| `table`/`thead`/`tbody`/`tr` | `{ children }` | Table elements |
| `th`/`td` | `{ align?, children }` | Table cells |
| `em`/`strong`/`del`/`u` | `{ children }` | Inline styles |
| `a` | `{ href, title?, children }` | Link |
| `img` | `{ src, alt?, title? }` | Image (no children) |
| `code` | `{ children }` | Inline code |
| `br` | `{}` | Line break |
| `html` | `{ children }` | Raw HTML |
| `math` | `{ children }` | LaTeX math |

```ts
function Code({ language, children }: { language?: string; children: React.ReactNode }) {
  return <pre data-language={language}><code>{children}</code></pre>;
}
function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank">{children}</a>;
}
const el = Bun.markdown.react(text, { pre: Code, a: Link }, { headings: { ids: true } });

// React 18 compatibility
const el18 = Bun.markdown.react(text, undefined, { reactVersion: 18 });
```

### 6. AnsiTheme (`ansi()` second argument)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `colors` | `boolean` | `true` | Emit ANSI color + styling escape sequences. `false` = plain ASCII (no box drawing, no emoji, no escape codes) |
| `columns` | `number` | `auto` | Line width for word-wrapping paragraphs/headings/HR. `0` = disable wrapping |
| `hyperlinks` | `boolean` | `false` | Emit OSC 8 hyperlinks (clickable in modern terminals). `false` = `text (url)` |
| `kittyGraphics` | `boolean` | `false` | Inline images via Kitty Graphics Protocol (Kitty, WezTerm, Ghostty). Falls through to text alt for remote URLs |
| `light` | `boolean` | `auto` | Terminal background is light. Affects inline code background color. Auto-detected from `COLORFGBG` env var |

### 7. ReactOptions (`react()` third argument)

Same as `Options` plus:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `reactVersion` | `18 \| 19` | `19` | Which `$$typeof` symbol to use. `19` = `Symbol.for('react.transitional.element')`; `18` = `Symbol.for('react.element')` (for React 18 and older) |

### 8. Integration Points in the Automation Platform

| Use Case | Function | Why |
|----------|----------|-----|
| **Dashboard log viewer** | `ansi()` | Render task logs (markdown-formatted) as colored terminal output in the live control panel |
| **Task description rendering** | `html()` | Convert user-submitted markdown task descriptions to HTML for the dashboard |
| **Session detail modal** | `react()` | Render markdown-formatted session notes as React components with custom styling |
| **Email/notification templates** | `html()` | Render markdown templates to HTML for notification emails |
| **Terminal-based admin CLI** | `ansi()` | Pretty-print task summaries, session details in the terminal with colors and hyperlinks |
| **GFM tables in reports** | `html()` with default `tables: true` | Render data collection reports with GFM tables |
| **Autolinked URLs in logs** | `html()` with `autolinks: true` | Auto-link URLs/emails in user-submitted task descriptions |
| **Heading IDs for deep linking** | `html()` with `headings: { ids: true }` | Generate anchor links for navigation within long reports |

**Note:** API is **Unstable** — may change in future Bun versions. Pin Bun version in production.

---

## Appendix: v1.3.14 Blog Header → Anchor → Task Map

> Complete extraction of all section headers from the [Bun v1.3.14 release blog](https://bun.com/blog/bun-v1.3.14) (May 13, 2026), mapped to canonical anchor URLs and cross-referenced against tasks in this document.
>
> Anchors verified from the blog's own link reference table. `##` = top-level section, `###` = subsection, `####` = sub-subsection.

### Top-level sections (`##`)

| # | Header | Anchor URL | Relevant Task |
|---|--------|------------|---------------|
| 1 | `Bun.Image` — Built-in Image Processing | [#bun-image-built-in-image-processing](https://bun.com/blog/bun-v1.3.14#bun-image-built-in-image-processing) | A4 (image.ts cast), D1 (screenshots) |
| 2 | Global Virtual Store | [#global-virtual-store](https://bun.com/blog/bun-v1.3.14#global-virtual-store) | — (install perf, not in tasks) |
| 3 | HTTP/3 (QUIC) support in `Bun.serve` | [#http-3-quic-support-in-bun-serve](https://bun.com/blog/bun-v1.3.14#http-3-quic-support-in-bun-serve) | **I3** ✅ |
| 4 | Experimental HTTP/2 Client for `fetch()` | [#experimental-http-2-client-for-fetch](https://bun.com/blog/bun-v1.3.14#experimental-http-2-client-for-fetch) | — (fetch perf, not in tasks) |
| 5 | Experimental HTTP/3 Client for `fetch()` | [#experimental-http-3-client-for-fetch](https://bun.com/blog/bun-v1.3.14#experimental-http-3-client-for-fetch) | — (fetch perf, not in tasks) |
| 6 | Rewritten `fs.watch()` backend on Linux, macOS, and FreeBSD | [#rewritten-fs-watch-backend-on-linux-macos-and-freebsd](https://bun.com/blog/bun-v1.3.14#rewritten-fs-watch-backend-on-linux-macos-and-freebsd) | — (file watching, not in tasks) |
| 7 | `--no-orphans` — exit when the parent process dies | [#no-orphans-exit-when-the-parent-process-dies](https://bun.com/blog/bun-v1.3.14#no-orphans-exit-when-the-parent-process-dies) | **I1** ✅ |
| 8 | `process.execve()` support | [#process-execve-support](https://bun.com/blog/bun-v1.3.14#process-execve-support) | **I2** ✅ |
| 9 | `Bun.Terminal` on Windows via ConPTY | [#bun-terminal-on-windows-via-conpty](https://bun.com/blog/bun-v1.3.14#bun-terminal-on-windows-via-conpty) | — (Windows-only, macOS target) |
| 10 | `using` / `await using` no longer lowered when targeting Bun | [#using-await-using-no-longer-lowered-when-targeting-bun](https://bun.com/blog/bun-v1.3.14#using-await-using-no-longer-lowered-when-targeting-bun) | **I4** ✅ |
| 11 | `SIGHUP` and `SIGBREAK` signal handling on Windows | [#sighup-and-sigbreak-signal-handling-on-windows](https://bun.com/blog/bun-v1.3.14#sighup-and-sigbreak-signal-handling-on-windows) | — (Windows-only) |
| 12 | WebSocket `perMessageDeflate: false` now respected in upgrade requests | [#websocket-permessagedeflate-false-now-respected-in-upgrade-requests](https://bun.com/blog/bun-v1.3.14#websocket-permessagedeflate-false-now-respected-in-upgrade-requests) | C1, C2 (WebSocket tasks) |
| 13 | FreeBSD and Android Support | [#freebsd-and-android-support](https://bun.com/blog/bun-v1.3.14#freebsd-and-android-support) | — (platform support) |
| 14 | Reduced memory usage for MongoDB & Mongoose | [#reduced-memory-usage-for-mongodb-mongoose](https://bun.com/blog/bun-v1.3.14#reduced-memory-usage-for-mongodb-mongoose) | — (using SQLite, not MongoDB) |
| 15 | Upgraded JavaScriptCore engine | [#upgraded-javascriptcore-engine](https://bun.com/blog/bun-v1.3.14#upgraded-javascriptcore-engine) | I4 (enables native `using`) |
| 16 | `bun publish` now sends README metadata to the registry | [#bun-publish-now-sends-readme-metadata-to-the-registry](https://bun.com/blog/bun-v1.3.14#bun-publish-now-sends-readme-metadata-to-the-registry) | — (publishing, not in tasks) |
| 17 | Updated SQLite to 3.53.0 | [#updated-sqlite-to-3-53-0](https://bun.com/blog/bun-v1.3.14#updated-sqlite-to-3-53-0) | Data layer (bun:sqlite usage) |
| 18 | Cross-language LTO for Zig ↔ C++ on Linux | [#cross-language-lto-for-zig-c-on-linux](https://bun.com/blog/bun-v1.3.14#cross-language-lto-for-zig-c-on-linux) | — (internal Bun build) |
| 19 | Faster ESM module loading | [#faster-esm-module-loading](https://bun.com/blog/bun-v1.3.14#faster-esm-module-loading) | A2 (require→import in ESM) |
| 20 | Reduced GC overhead for built-in objects | [#reduced-gc-overhead-for-built-in-objects](https://bun.com/blog/bun-v1.3.14#reduced-gc-overhead-for-built-in-objects) | — (general perf) |
| 21 | Smaller binary size | [#smaller-binary-size](https://bun.com/blog/bun-v1.3.14#smaller-binary-size) | Build (61MB standalone executable) |
| 22 | `tls.getCACertificates('system')` now works without `--use-system-ca` | [#tls-getcacertificates-system-now-works-without-use-system-ca](https://bun.com/blog/bun-v1.3.14#tls-getcacertificates-system-now-works-without-use-system-ca) | I3 (TLS for HTTP/3) |
| 23 | `tls.getCACertificates('system')` no longer stalls on managed Macs | [#tls-getcacertificates-system-no-longer-stalls-on-managed-macs](https://bun.com/blog/bun-v1.3.14#tls-getcacertificates-system-no-longer-stalls-on-managed-macs) | I3 (TLS for HTTP/3) |
| 24 | `--use-system-ca` on Windows now loads intermediate and TrustedPeople certificates | [#use-system-ca-on-windows-now-loads-intermediate-and-trustedpeople-certificates](https://bun.com/blog/bun-v1.3.14#use-system-ca-on-windows-now-loads-intermediate-and-trustedpeople-certificates) | — (Windows-only) |
| 25 | Event loop refactor | [#event-loop-refactor](https://bun.com/blog/bun-v1.3.14#event-loop-refactor) | — (general perf) |
| 26 | Bugfixes | [#bugfixes](https://bun.com/blog/bun-v1.3.14#bugfixes) | Various (see subsections below) |
| 27 | Thanks to 11 contributors! | [#thanks-to-11-contributors](https://bun.com/blog/bun-v1.3.14#thanks-to-11-contributors) | — (credits) |

### Subsections (`###`) under `Bun.Image`

| Header | Anchor URL |
|--------|------------|
| Input sources | [#input-sources](https://bun.com/blog/bun-v1.3.14#input-sources) |
| Chainable transforms | [#chainable-transforms](https://bun.com/blog/bun-v1.3.14#chainable-transforms) |
| Resize filters | [#resize-filters](https://bun.com/blog/bun-v1.3.14#resize-filters) |
| Terminal methods | [#terminal-methods](https://bun.com/blog/bun-v1.3.14#terminal-methods) |
| Body integration | [#body-integration](https://bun.com/blog/bun-v1.3.14#body-integration) |
| Platform-specific formats | [#platform-specific-formats](https://bun.com/blog/bun-v1.3.14#platform-specific-formats) |
| Performance vs sharp 0.34.5 | [#performance-vs-sharp-0-34-5](https://bun.com/blog/bun-v1.3.14#performance-vs-sharp-0-34-5) |

### Subsections (`###`) under HTTP/3

| Header | Anchor URL |
|--------|------------|
| Performance | [#performance](https://bun.com/blog/bun-v1.3.14#performance) |
| Limitations | [#limitations](https://bun.com/blog/bun-v1.3.14#limitations) |

### Subsections (`###`) under HTTP/2 Client

| Header | Anchor URL |
|--------|------------|
| Multiplexing & connection coalescing | [#multiplexing-connection-coalescing](https://bun.com/blog/bun-v1.3.14#multiplexing-connection-coalescing) |
| Per-request protocol control | [#per-request-protocol-control](https://bun.com/blog/bun-v1.3.14#per-request-protocol-control) |
| What works | [#what-works](https://bun.com/blog/bun-v1.3.14#what-works) |
| Hardening | [#hardening](https://bun.com/blog/bun-v1.3.14#hardening) |
| Not yet supported | [#not-yet-supported](https://bun.com/blog/bun-v1.3.14#not-yet-supported) |

### Subsections (`###`) under HTTP/3 Client

| Header | Anchor URL |
|--------|------------|
| Alt-Svc HTTP/3 upgrades | [#alt-svc-http-3-upgrades](https://bun.com/blog/bun-v1.3.14#alt-svc-http-3-upgrades) |

### Subsections (`###`) under `fs.watch()`

| Header | Anchor URL |
|--------|------------|
| Recursive watching now tracks new directories (Linux) | [#recursive-watching-now-tracks-new-directories-linux](https://bun.com/blog/bun-v1.3.14#recursive-watching-now-tracks-new-directories-linux) |
| Deleted-and-recreated files emit `change` events again (Linux) | [#deleted-and-recreated-files-emit-change-events-again-linux](https://bun.com/blog/bun-v1.3.14#deleted-and-recreated-files-emit-change-events-again-linux) |
| macOS no longer spins up two watcher threads | [#macos-no-longer-spins-up-two-watcher-threads](https://bun.com/blog/bun-v1.3.14#macos-no-longer-spins-up-two-watcher-threads) |

### Subsections (`###`) under `Bun.Terminal`

| Header | Anchor URL |
|--------|------------|
| Platform differences | [#platform-differences](https://bun.com/blog/bun-v1.3.14#platform-differences) |

### Subsections (`###`) under JavaScriptCore

| Header | Anchor URL |
|--------|------------|
| JavaScript performance & correctness | [#javascript-performance-correctness](https://bun.com/blog/bun-v1.3.14#javascript-performance-correctness) |
| Bug fixes from upstream | [#bug-fixes-from-upstream](https://bun.com/blog/bun-v1.3.14#bug-fixes-from-upstream) |
| WebAssembly | [#webassembly](https://bun.com/blog/bun-v1.3.14#webassembly) |

### Subsections (`###`) under Bugfixes

| Header | Anchor URL | Relevant Task |
|--------|------------|---------------|
| Node.js compatibility improvements | [#node-js-compatibility-improvements](https://bun.com/blog/bun-v1.3.14#node-js-compatibility-improvements) | A2 (require in ESM) |
| Bun APIs | [#bun-apis](https://bun.com/blog/bun-v1.3.14#bun-apis) | Various |
| `bun:sql` | [#bun-sql](https://bun.com/blog/bun-v1.3.14#bun-sql) | Data layer |
| Web APIs | [#web-apis](https://bun.com/blog/bun-v1.3.14#web-apis) | C1, C2 (WebSocket) |
| Security | [#security](https://bun.com/blog/bun-v1.3.14#security) | B1, B2, B3 |
| Timers | [#timers](https://bun.com/blog/bun-v1.3.14#timers) | E1 (cron) |
| bun install | [#bun-install](https://bun.com/blog/bun-v1.3.14#bun-install) | — |
| JavaScript bundler | [#javascript-bundler](https://bun.com/blog/bun-v1.3.14#javascript-bundler) | Build |
| Module resolver | [#module-resolver](https://bun.com/blog/bun-v1.3.14#module-resolver) | A2 |
| Dev server / HMR | [#dev-server-hmr](https://bun.com/blog/bun-v1.3.14#dev-server-hmr) | F1 (dashboard) |
| `bun build --compile` | [#bun-build-compile](https://bun.com/blog/bun-v1.3.14#bun-build-compile) | Build (61MB executable) |
| CSS Parser | [#css-parser](https://bun.com/blog/bun-v1.3.14#css-parser) | F1 (dashboard) |
| bun test | [#bun-test](https://bun.com/blog/bun-v1.3.14#bun-test) | H1 (unit tests) |
| Bun Shell | [#bun-shell](https://bun.com/blog/bun-v1.3.14#bun-shell) | — |
| TypeScript types | [#typescript-types](https://bun.com/blog/bun-v1.3.14#typescript-types) | A4 (as any cast) |
| Windows | [#windows](https://bun.com/blog/bun-v1.3.14#windows) | — (macOS target) |
| CLI and runtime | [#cli-and-runtime](https://bun.com/blog/bun-v1.3.14#cli-and-runtime) | — |

### Subsections (`####`) under CLI and runtime

| Header | Anchor URL | Description |
|--------|------------|-------------|
| Pipeline producer exit no longer clobbers downstream pager's terminal state | [#pipeline-producer-exit-no-longer-clobbers-downstream-pager-s-terminal-state](https://bun.com/blog/bun-v1.3.14#pipeline-producer-exit-no-longer-clobbers-downstream-pager-s-terminal-state) | When piping to pagers (`bun script.js \| less`), gates exit-time `tcsetattr` so raw mode is preserved |
| Other CLI/runtime fixes | [#other-cli-runtime-fixes](https://bun.com/blog/bun-v1.3.14#other-cli-runtime-fixes) | `bun -p` with top-level `await` now returns final completion value (`bun -p '(await 1) + 1'` prints 2 instead of 1) |

### Coverage summary

| Status | Count | Sections |
|--------|-------|----------|
| ✅ Directly referenced in a task | 4 | I1, I2, I3, I4 |
| 📎 Relevant to existing tasks (not yet linked) | 12 | Bun.Image, WebSocket perMessageDeflate, JSC upgrade, SQLite 3.53.0, ESM loading, binary size, TLS certs (×2), Node.js compat, bun:sql, Web APIs, Security |
| — Not relevant to current tasks | 11 | Global Virtual Store, HTTP/2 client, HTTP/3 client, fs.watch, Bun.Terminal, SIGHUP/SIGBREAK, FreeBSD/Android, MongoDB, bun publish, LTO, GC overhead, event loop, Windows CA, CLI/runtime |
