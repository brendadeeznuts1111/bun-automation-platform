# BUN-DEV — 100% Bun Deep Enhancement Outline

Grounded in **Bun v1.3.14** (latest stable, May 13 2026) + local installed docs.
Every item cites the exact Bun API from `node_modules/bun-types/docs/`.

## Current State (already implemented)

| API | Where | What it does |
|---|---|---|
| `Bun.serve` + `routes` | `src/server.ts` | Native routing, 27 routes |
| `bun:sqlite` (WAL) | `src/db/index.ts` | Writer + reader pool, atomic rate limiting |
| `Bun.CSRF` | `src/middleware/csrf.ts` | HMAC-signed CSRF tokens |
| `Bun.password` | `src/middleware/auth.ts` | bcrypt hashing + verify |
| `Bun.JSONL` | `src/server.ts` | Streaming JSONL exports |
| `Bun.markdown.html` | `src/server.ts` | `POST /api/markdown` |
| `Bun.color` | `src/server.ts` | `GET /api/color` |
| `Bun.Image` | `src/utils/image.ts` | Screenshot processing |
| `Bun.WebView` | `src/worker/` | Headless browser automation |
| `Bun.spawn` | `src/pool.ts` | Worker subprocess pool |
| `Bun.inflateSync` | `src/worker/` | Decompression |
| `Bun.CryptoHasher` | `src/middleware/` | Token hashing |
| `HTMLRewriter` | `src/server.ts` | Dashboard HTML injection |
| `ReadableStream` | `src/server.ts` | Streaming JSONL from SQLite |

## 16 Unused Bun APIs (enhancement targets)

---

### Phase 1 — Security & Resilience (Critical)

#### 1.1 `Bun.secrets` — OS-native credential storage
**Doc:** `node_modules/bun-types/docs/runtime/secrets.mdx`
**Blog:** v1.3.14

Replace plaintext `.env` `MASTER_KEY` with OS keychain (macOS Keychain, Windows Credential Manager, Linux libsecret).

```ts
import { secrets } from "bun";
const key = await secrets.get({ service: "bun-dev", name: "master-key" })
  ?? (await secrets.set({ service: "bun-dev", name: "master-key", value: crypto.randomUUID() }));
```

**Impact:** Eliminates plaintext secrets on disk. Zero external deps.
**Files:** `src/db/index.ts`, `src/middleware/auth.ts`, new `src/utils/secrets.ts`

#### 1.2 `Bun.Cookie` / `Bun.CookieMap` — Native cookie handling
**Doc:** `node_modules/bun-types/docs/runtime/cookies.mdx`

Replace manual `Set-Cookie` header string building with typed `Bun.CookieMap`.

```ts
const cookies = new Bun.CookieMap(req.headers.get("cookie") ?? "");
cookies.set("session", token, { httpOnly: true, secure: true, sameSite: "strict", maxAge: 3600 });
```

**Impact:** Eliminates cookie parsing bugs, adds typed `SameSite`/`HttpOnly`/`Secure` flags.
**Files:** `src/middleware/auth.ts`, `src/server.ts` (login handler)

#### 1.3 CSP nonces via `HTMLRewriter`
**Doc:** `node_modules/bun-types/docs/runtime/html-rewriter.mdx`

Inject per-request `nonce` attributes on all `<script>` tags + `Content-Security-Policy` header.

```ts
new HTMLRewriter()
  .on("script", { element(el) { el.setAttribute("nonce", nonce); } })
  .transform(response);
```

**Impact:** Prevents XSS on `/dashboard` and `POST /api/markdown` output.
**Files:** `src/server.ts` (HTMLRewriter section, already present)

#### 1.4 TLS + HTTP/3 (already scaffolded, needs certs)
**Doc:** `node_modules/bun-types/docs/runtime/http/tls.mdx`
**Blog:** v1.3.14 — HTTP/3 over QUIC

```ts
Bun.serve({
  tls: { cert: Bun.file(TLS_CERT_PATH), key: Bun.file(TLS_KEY_PATH) },
  http3: true, // single flag — Alt-Svc auto-sent
});
```

**Impact:** 0-RTT connection resumption, multiplexed streams, PWA becomes "secure context" (required for SW).
**Blocker:** Requires cert generation — user action needed.

---

### Phase 2 — Real-Time Observability

#### 2.1 `Bun.cron` — Scheduled health checks & log rotation
**Doc:** `node_modules/bun-types/docs/runtime/cron.mdx`
**Blog:** v1.3.11

```ts
// Every 15 min: health check
Bun.cron("*/15 * * * *", async () => {
  const pool = getPoolStatus();
  write((db) => db.run("INSERT INTO health_log VALUES (?, ?)", [Date.now(), JSON.stringify(pool)]));
});

// Daily at 2 AM: archive old audit logs
Bun.cron("0 2 * * *", async () => {
  const cutoff = Date.now() - 30 * 86400_000;
  write((db) => db.run("DELETE FROM audit_log WHERE ts < ?", [cutoff]));
});
```

**Impact:** No external cron daemon. OS-level option survives restarts: `Bun.cron("./cleanup.ts", "0 2 * * *", "audit-cleanup")`.
**Files:** New `src/cron/index.ts`, `src/server.ts` (register on startup)

#### 2.2 WebSocket live metrics (already scaffolded)
**Doc:** `node_modules/bun-types/docs/runtime/http/websockets.mdx`

Enable `ENABLE_WEBSOCKET` flag, add `/ws/metrics` channel that pushes pool status every 500ms.

```ts
websocket: {
  message() {},
  open(ws) { ws.subscribe("metrics"); },
}
// In Bun.serve:
setInterval(() => {
  server.publish("metrics", JSON.stringify(getPoolStatus()));
}, 500);
```

**Impact:** Dashboard becomes real-time control panel. Worker busy/idle chart updates live.
**Files:** `src/server.ts` (websocket config section, line 1868)

#### 2.3 SSE live audit log stream
**Doc:** `node_modules/bun-types/docs/runtime/streams.mdx`

```ts
"/api/audit/stream": { GET: withAuth((req) => {
  const stream = new ReadableStream({
    start(controller) {
      auditEmitter.on("entry", (entry) => {
        controller.enqueue(`data: ${JSON.stringify(entry)}\n\n`);
      });
    }
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
})}
```

**Impact:** Real-time request log in dashboard terminal window. No WebSocket needed for one-way push.
**Files:** `src/server.ts`, `src/db/audit.ts` (add EventEmitter)

#### 2.4 `Bun.semver` — API version negotiation
**Doc:** `node_modules/bun-types/docs/runtime/semver.mdx`

```ts
if (Bun.semver.satisfies(clientVersion, ">=1.3.14")) {
  // Use HTTP/3 + new features
} else {
  // Fallback to HTTP/1.1
}
```

**Impact:** Graceful feature degradation based on client Bun version. 20x faster than `node-semver`.
**Files:** `src/server.ts` (protocol handler)

---

### Phase 3 — Data Pipeline & Persistence

#### 3.1 `Bun.Archive` — Tar log rotation & export bundles
**Doc:** `node_modules/bun-types/docs/runtime/archive.mdx`
**Blog:** v1.3.14

```ts
const archive = new Bun.Archive({
  "audit-2026-08-15.jsonl": auditJsonl,
  "tasks-2026-08-15.jsonl": tasksJsonl,
  "manifest.json": JSON.stringify(manifest),
});
await Bun.write(`exports/${date}.tar`, archive);
```

**Impact:** One endpoint `GET /api/export/:date.tar` bundles all JSONL + manifest. No external tar lib.
**Files:** New `src/utils/archive.ts`, `src/server.ts`

#### 3.2 `Bun.s3` — Offsite backup to S3-compatible storage
**Doc:** `node_modules/bun-types/docs/runtime/s3.mdx`

```ts
import { s3, write } from "bun";
const backup = s3.file(`backups/${date}.tar`);
await write(backup, archive);
const presignedUrl = backup.presign({ expiresInSeconds: 3600 });
```

**Impact:** Cron job uploads daily tar to S3/R2/MinIO. Presigned URLs for dashboard download.
**Files:** `src/cron/backup.ts`, `src/server.ts`

#### 3.3 `Bun.redis` — Distributed rate limiting & caching
**Doc:** `node_modules/bun-types/docs/runtime/redis.mdx`

```ts
import { redis } from "bun";
// Replace SQLite rate limiter with Redis for multi-instance deployments
const count = await redis.incr(`rate:${ip}:${minute}`);
if (count > 100) return new Response("Too Many Requests", { status: 429 });
await redis.expire(`rate:${ip}:${minute}`, 60);
```

**Impact:** Horizontal scaling. Rate limits work across multiple Bun processes.
**Files:** `src/middleware/rate-limit.ts` (add Redis backend)

#### 3.4 `Bun.sql` — PostgreSQL/MySQL support
**Doc:** `node_modules/bun-types/docs/runtime/sql.mdx`

```ts
import { sql } from "bun";
// Tagged template literals — SQL injection safe
const tasks = await sql`SELECT * FROM tasks WHERE status = ${status} LIMIT ${limit}`;
```

**Impact:** Production deployments can use Postgres instead of SQLite. Same query syntax.
**Files:** New `src/db/postgres.ts` (optional backend)

---

### Phase 4 — Developer Experience

#### 4.1 `Bun.YAML` / `Bun.TOML` / `Bun.JSON5` — Multi-format config
**Docs:** `runtime/yaml.mdx`, `runtime/toml.mdx`, `runtime/json5.mdx`

```ts
// Parse bunfig.toml at runtime
const config = Bun.TOML.parse(await Bun.file("bunfig.toml").text());
// Parse docker-compose.yml
const compose = Bun.YAML.parse(await Bun.file("docker-compose.yml").text());
// Parse JSON5 with comments
const tsconfig = Bun.JSON5.parse(await Bun.file("tsconfig.json5").text());
```

**Impact:** Dashboard can read/validate/display all config formats. New endpoint `GET /api/config` returns merged config from `.env` + `bunfig.toml` + `package.json`.
**Files:** New `src/utils/config.ts`, `src/server.ts`

#### 4.2 `Bun.glob` — File discovery for sitemap & diagrams
**Doc:** `node_modules/bun-types/docs/runtime/glob.mdx`

```ts
import { Glob } from "bun";
const glob = new Glob("**/*.{ts,tsx,md,mermaid}");
for await (const file of glob.scan("./docs")) {
  // Auto-discover diagram files for /diagrams route
}
```

**Impact:** `/diagrams` auto-discovers `.mmd` files. Sitemap auto-includes static assets. No manual route list.
**Files:** `src/server.ts` (sitemap handler, diagrams handler)

#### 4.3 `Bun.shell` — Admin scripts from dashboard
**Doc:** `node_modules/bun-types/docs/runtime/shell.mdx`

```ts
import { $ } from "bun";
// POST /api/admin/vacuum — vacuum SQLite DB
await $`bun -e "import {Database} from 'bun:sqlite'; new Database('data.db').exec('VACUUM')"`;
// POST /api/admin/restart-workers — graceful worker restart
await $`kill -USR2 ${workerPids.join(" ")}`;
```

**Impact:** Dashboard "Admin" panel can run safe, pre-approved shell commands. Bun Shell escapes all interpolation — no injection.
**Files:** New `src/admin/shell.ts`, `src/server.ts`

#### 4.4 `--hot` mode for development
**Doc:** `node_modules/bun-types/docs/runtime/watch-mode.mdx`

```bash
bun --hot run src/server.ts
```

**Impact:** Edit `src/server.ts` → code hot-reloads without dropping connections. WebSocket clients stay connected. No `nodemon` needed.
**Files:** `package.json` (dev script), `AGENTS.md`

#### 4.5 OpenAPI spec auto-generation
**Doc:** `node_modules/bun-types/docs/runtime/http/routing.mdx`

Introspect the `routes` object and generate OpenAPI 3.1 JSON:

```ts
"/docs": { GET: () => {
  const spec = generateOpenAPI(routes); // walks route table
  return Response.json(spec, { headers: { "Content-Type": "application/json" } });
}}
```

**Impact:** Swagger UI at `/docs`. 27 routes auto-documented. No external spec library.
**Files:** New `src/utils/openapi.ts`, `src/server.ts`

---

### Phase 5 — UI/UX Overhaul

#### 5.1 Dynamic feature toggle API
**Doc:** `node_modules/bun-types/docs/runtime/bun-apis.mdx` (in-memory state)

```ts
const featureState = new Map<string, boolean>();
"/api/features/toggle": { POST: withAuth(withCsrf((req) => {
  const { key, enabled } = req.json();
  featureState.set(key, enabled);
  auditLog("feature_toggle", { key, enabled, user: ctx.user });
  return Response.json({ ok: true });
}))}
```

**Impact:** Toggle features from dashboard without restart. Audit trail logs who toggled what.
**Files:** `src/features/registry.ts`, `src/server.ts`

#### 5.2 Mermaid live render
**Doc:** `node_modules/bun-types/docs/runtime/markdown.mdx`

```ts
"/api/mermaid": { POST: withAuth(async (req) => {
  const { code } = await req.json();
  // Use Bun.WebView to render mermaid.js → SVG
  await using view = new Bun.WebView();
  await view.navigate("data:text/html,<script src='mermaid.min.js'></script><div class='mermaid'>" + code + "</div>");
  const svg = await view.evaluate("document.querySelector('svg').outerHTML");
  return new Response(svg, { headers: { "Content-Type": "image/svg+xml" } });
})}
```

**Impact:** Paste Mermaid code in dashboard → instant SVG render. Uses `Bun.WebView` (already integrated).
**Files:** `src/server.ts`, dashboard HTML (textarea + render button)

#### 5.3 Dark/light mode via `prefers-color-scheme`
**Doc:** CSS media query (no Bun API needed, but HTMLRewriter can inject)

```css
@media (prefers-color-scheme: light) {
  :root { --bg: #ffffff; --fg: #1a1a1a; --accent: #0066cc; }
}
```

**Impact:** Respects system theme. PWA feels native on both light/dark OS.
**Files:** `src/server.ts` (dashboard CSS)

#### 5.4 `Bun.markdown.ansi` — Terminal dashboard
**Doc:** `node_modules/bun-types/docs/runtime/markdown.mdx`
**Blog:** v1.3.12

```ts
// CLI: bun run src/cli/dashboard.ts
const status = `# BUN-DEV Status\n- Uptime: ${uptime}s\n- Workers: ${pool.idle}/${pool.total} idle`;
console.log(Bun.markdown.ansi(status));
```

**Impact:** `bun run src/cli/dashboard.ts` prints a beautiful ANSI-colored status in terminal. No browser needed.
**Files:** New `src/cli/dashboard.ts`

---

### Phase 6 — Testing & CI

#### 6.1 `bun test --parallel` + `--isolate`
**Blog:** v1.3.13

```bash
bun test --parallel=4 --isolate
```

**Impact:** 4x faster test suite (2354 tests → ~1s). Per-file isolation prevents cross-test contamination.
**Files:** `package.json` (test script)

#### 6.2 `bun test --changed`
**Blog:** v1.3.13

```bash
bun test --changed
```

**Impact:** Only runs tests affected by git changes. Instant feedback loop during development.
**Files:** `package.json` (test:changed script)

#### 6.3 `bun test --shard=M/N`
**Blog:** v1.3.13

```yaml
# CI matrix: 4 parallel jobs
- bun test --shard=1/4
- bun test --shard=2/4
- bun test --shard=3/4
- bun test --shard=4/4
```

**Impact:** CI test time cut 4x. Each shard runs independent subset.
**Files:** `.github/workflows/test.yml`

---

## Priority Implementation Order

| # | Enhancement | Bun API | Impact | Effort |
|---|---|---|---|---|
| 1 | CSP nonces | `HTMLRewriter` | Security critical | Low |
| 2 | `Bun.cron` log rotation | `Bun.cron` | Auto-cleanup, no daemon | Low |
| 3 | Dynamic feature toggle | in-memory Map | DX, no restart | Low |
| 4 | `Bun.secrets` | `secrets` | Eliminates plaintext keys | Medium |
| 5 | `Bun.Cookie` | `Bun.CookieMap` | Typed cookie handling | Low |
| 6 | SSE live audit stream | `ReadableStream` | Real-time logs | Medium |
| 7 | WebSocket live metrics | `Bun.serve websocket` | Real-time dashboard | Medium |
| 8 | `Bun.Archive` export bundles | `Bun.Archive` | One-file exports | Low |
| 9 | `Bun.glob` auto-discovery | `Glob` | Auto sitemap/diagrams | Low |
| 10 | `Bun.YAML`/`TOML`/`JSON5` config | `Bun.YAML` etc. | Multi-format config | Low |
| 11 | OpenAPI auto-gen | route introspection | `/docs` Swagger | Medium |
| 12 | `Bun.shell` admin panel | `$` | Safe admin commands | Medium |
| 13 | `--hot` dev mode | CLI flag | Instant reload | Trivial |
| 14 | `bun test --parallel` | CLI flag | 4x test speed | Trivial |
| 15 | Mermaid live render | `Bun.WebView` | In-browser diagrams | Medium |
| 16 | `Bun.markdown.ansi` CLI | `Bun.markdown.ansi` | Terminal dashboard | Low |
| 17 | `Bun.s3` backups | `s3` | Offsite storage | Medium |
| 18 | `Bun.redis` rate limiting | `redis` | Horizontal scaling | Medium |
| 19 | `Bun.semver` negotiation | `Bun.semver` | Graceful degradation | Low |
| 20 | `Bun.sql` Postgres | `sql` | Production DB | High |
| 21 | Dark/light mode | CSS media query | Theme parity | Trivial |
| 22 | TLS + HTTP/3 | `Bun.serve tls` | Security + perf | Needs certs |

## Bun API Coverage Score

```
Currently used:     14 / 30 APIs (47%)
After Phase 1-3:    22 / 30 APIs (73%)
After Phase 4-6:    28 / 30 APIs (93%)
```

The 2 remaining (FFI, Bun.console) are niche — FFI for native C bindings, console for structured stdout. Could add `Bun.console` for structured logging in Phase 4.
