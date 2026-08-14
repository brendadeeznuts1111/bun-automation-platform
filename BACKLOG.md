# Gap Analysis – Bun Automation Platform (v1.3.14+)

Even with Bun's latest features, several gaps remain. They fall into **production hardening**, **scalability**, **observability**, **security**, **business logic**, and **integration** categories. Many of these are not solved by Bun itself and require custom code or third-party libraries.

---

## 1. Production Hardening Gaps

| Gap | Description | Impact | Suggested Solution |
|-----|-------------|--------|---------------------|
| **No graceful shutdown for workers** | When the server receives `SIGTERM`, workers are killed abruptly, potentially leaving sessions in an inconsistent state. | Corrupted tasks, stranded browser processes. | Listen to `process.on('SIGTERM')` in the main process and forward a shutdown signal to workers via IPC; wait for workers to finish. |
| **No retry logic** | If a WebView login fails (network glitch, CAPTCHA), the task fails immediately. | Lower success rate; manual intervention needed. | Implement exponential backoff retries (e.g., 3 attempts) within the worker, with configurable delays. |
| **No circuit breaker** | If a target site is down, the system keeps retrying and wasting resources. | Resource exhaustion and potential IP ban. | Implement a circuit breaker – skip scraping for 5 minutes after N consecutive failures. |
| **No health check endpoint** | No `/health` endpoint for orchestration (Kubernetes, Docker). | Orchestration tools can't detect if the service is alive. | Add `GET /health` that returns `{ status: "ok" }` and optionally checks DB connectivity. |
| **No timeout for WebView operations** | `waitForSelector`, `navigate` have default timeouts (30s), but no configurable global timeout. | A stalled page may hang the worker indefinitely. | Use `Bun.spawn` with `timeout` (already done) and also set per-operation timeouts. |
| **No error recovery for sessions** | If a session expires mid-collection, the data collection may fail without retry. | Partial data loss. | Implement `refreshSessionOnError` that re-logs in and retries the API call. |
| **No validation of API responses** | The system assumes the target site always returns valid JSON. | Parse errors may crash the worker. | Wrap API responses with Zod or manual validation; gracefully handle malformed responses. |

---

## 2. Scalability & Performance Gaps

| Gap | Description | Impact | Suggested Solution |
|-----|-------------|--------|---------------------|
| **SQLite as the only data store** | SQLite is single-file and not designed for high concurrency or distributed deployments. | As the number of agents grows, SQLite may become a bottleneck; horizontal scaling is impossible. | Use PostgreSQL (or MySQL) for production; keep SQLite for local dev and testing. |
| **No connection pooling for DB** | Each worker opens its own SQLite connection (or uses the same file, causing locking). | Contention and poor performance under load. | Use a connection pool (e.g., `pg.Pool` for PostgreSQL) and share it across workers (or use a separate DB per worker). |
| **Workers are short-lived** | Each task spawns a new Bun process – startup overhead (~50ms) adds up. | For high-frequency tasks, this wastes CPU. | Implement a worker pool: pre-spawn N workers with `Bun.spawn({ ipc: true })` and keep them alive. Send tasks via `child.send(taskId)`, receive results via `child.on("message", ...)`. The v1.3.14 GC leak fix for `ipc` subprocesses makes this safe (see section 8). |
| **No task prioritisation** | All tasks are processed FIFO; urgent tasks may wait behind long-running ones. | Agents may experience delays for critical operations. | Add a `priority` column to tasks and process higher-priority tasks first. |
| **No caching for API responses** | Repeated API calls (e.g., `getSportsLeagues`) hit the target site every time. | Wastes network and may trigger rate limits. | Cache responses in Redis or an in-memory LRU with TTL (e.g., 60 seconds). |
| **No distributed locking for cron jobs** | `Bun.cron` runs in-process on each server instance; in a multi-server setup, cron jobs overlap. | Duplicate work and potential race conditions. | Use Redis distributed locks (e.g., `redlock`) to ensure only one instance runs the cron job. |
| **No queuing system** | Tasks are stored in SQLite and picked up by spawning workers, but there is no dedicated queue (like Redis or SQS). | Limited scalability; no retry mechanism or dead-letter queue. | Integrate a queue (BullMQ, SQS) to manage tasks with retries, delays, and priorities. |

---

## 3. Observability & Monitoring Gaps

| Gap | Description | Impact | Suggested Solution |
|-----|-------------|--------|---------------------|
| **No structured logs** | `console.log` with `%j` is used, but no log levels, rotation, or aggregation. | Hard to debug production issues; logs may fill up disk. | Use a structured logger like `pino` with log levels (`info`, `warn`, `error`) and transport to a file or ELK stack. |
| **No metrics / Prometheus endpoint** | No counters for tasks, sessions, errors, response times. | Cannot monitor health or detect anomalies. | Expose a `/metrics` endpoint with Prometheus-format metrics (use `bun-prometheus` or manual counters). |
| **No distributed tracing** | No `traceId` propagation across HTTP requests and workers. | Hard to trace a single request through the system. | Add a `traceId` header and log it; propagate via IPC to workers. |
| **No alerting** | No integration with alerting systems (e.g., PagerDuty, Slack). | Failures are not proactively reported. | Integrate with a notification service (e.g., using `fetch` to send webhooks). |
| **No performance monitoring** | No profiling or CPU/memory usage tracking. | Cannot identify bottlenecks. | Use `Bun.spawn` resource usage (`proc.resourceUsage()`) and expose metrics. |

---

## 4. Security Gaps

| Gap | Description | Impact | Suggested Solution |
|-----|-------------|--------|---------------------|
| **No rate limiting** | No protection against excessive requests (e.g., 1000 task submissions in 1 second). | Could lead to resource exhaustion (DoS) or abuse. | Use `bun-rate-limiter` or implement a rolling-window counter in SQLite/Redis. |
| **No IP allowlisting** | The dashboard API is exposed to the public internet. | Anyone can attempt to brute-force agent logins or submit tasks. | Implement IP allowlisting (or use API keys) for sensitive endpoints. |
| **No session invalidation on password change** | If an agent changes their target-site password, the stored session remains valid until it expires. | The system may continue using stale credentials, leading to failed logins and confusion. | Provide a "refresh" button that re-logs in with the new password and updates the stored encrypted credentials. |
| **No audit trail** | No log of who performed which action (e.g., who closed a session, who viewed a screenshot). | Cannot track misuse or debug issues. | Add an `audit_log` table with `agent_id`, `action`, `timestamp`, `details`. |
| **No credential rotation policy** | Credentials are stored encrypted, but there's no automatic rotation or expiry. | If a master key is compromised, all credentials are exposed. | Implement key rotation and re-encryption; set per-credential expiry (e.g., 90 days). |
| **CORS policy is permissive** | In development, `Access-Control-Allow-Origin: *` is used. | In production, this could allow malicious sites to call your API. | Restrict to your trusted domain(s) (e.g., the dashboard domain). |
| **No content security policy (CSP)** | The HTML dashboard lacks CSP headers. | XSS risks if agent-supplied data is rendered unsafely. | Set CSP headers (e.g., `default-src 'self'`) in `Bun.serve` responses. |
| **Secrets in environment** | `MASTER_KEY` is stored in `.env` (plaintext on disk). | If the server is breached, the key is exposed. | Use a dedicated secrets manager (AWS Secrets Manager, Vault) in production; use `Bun.secrets` only as a fallback for local dev. |
| **No integrity checks** | No verification that the downloaded `worker.ts` or `server.ts` hasn't been tampered with. | Supply-chain attacks could inject malicious code. | Use checksums or signed releases; employ `Bun.hash` to validate file integrity. |

---

## 5. User Experience (Dashboard) Gaps

| Gap | Description | Impact | Suggested Solution |
|-----|-------------|--------|---------------------|
| **No real-time updates** | The dashboard relies on manual refresh to see task progress. | Agents must constantly click "Refresh". | Use WebSocket or Server-Sent Events (SSE) to push progress updates. |
| **No pagination / filtering** | Task list grows; no filtering by status or search. | Hard to find a specific task. | Add client-side filtering or server-side pagination. |
| **No error notifications** | Agents are not notified when a task fails (only see `failed` status). | They may not act in time. | Send email/Telegram notifications on failure. |
| **No credential update UI** | Agents cannot update a saved credential without deleting and re-adding. | Cumbersome. | Add an "Edit" button that shows a modal with pre-filled username and password fields. |
| **No "quick login" for recent sites** | Agents must fill the form each time (or use saved credentials, but still need to select). | Slower workflow. | Add a "Recent Sites" dropdown that auto-fills the form with saved credentials. |
| **No progress bar in task list** | Only a percentage number. | Less intuitive. | Render a visual progress bar (HTML `<progress>`). |
| **No session expiry warning** | Agents don't know when a session is about to expire. | They may be surprised by a failed health check. | Display a countdown or "expires at" timestamp. |

---

## 6. Business Logic & Feature Gaps

| Gap | Description | Impact | Suggested Solution |
|-----|-------------|--------|---------------------|
| **No multi-account support** | An agent may have multiple accounts on the same site (different credentials). | Currently only one set of credentials per agent per site. | Support multiple profiles (e.g., `profile_name` field) and allow agents to switch. |
| **No line-movement detection** | For sports betting, agents need to know when odds change. | They must manually check. | Implement delta detection and send alerts (Telegram/email) when lines move. |
| **No transaction logging** | If agents can place bets via the API, there is no record. | No audit of bets placed. | Log every betting API call with request/response payloads. |
| **No risk management** | Betting limits and exposure need to be tracked. | Agents may exceed limits unknowingly. | Store limits and compare against placed bets; alert if approaching a limit. |
| **No event scheduling** | Some sports events are only available at specific times – you need to know when to collect data. | You may miss events. | Parse schedules from the API and pre-schedule data collection using `Bun.cron`. |

---

## 7. Integration & Missing Bun Features

| Gap | Description | Suggested Solution |
|-----|-------------|---------------------|
| **No built-in queue** | Bun lacks a native queuing system. | Use Redis + BullMQ or implement a simple job queue with `Bun.spawn` and a shared database. |
| **No official ORM** | Bun doesn't provide an ORM; raw SQL queries are used. | Use Drizzle ORM or Kysely for type-safe queries and migrations. |
| **No built-in distributed locks** | Bun doesn't have a distributed lock primitive. | Use Redis with `SETNX` or the `redlock` library. |
| **No WebView recording** | `Bun.WebView` doesn't support recording (video). | For replay, use screenshots and action logs; for live control, use WebSocket streaming. |

---

## Summary of Critical Gaps (Priority Order)

| Priority | Category | Top Gaps |
|----------|----------|----------|
| Critical | Security | No rate limiting, no IP allowlisting, permissive CORS, no audit trail |
| Critical | Reliability | No retry logic, no circuit breaker, no graceful shutdown |
| High | Scalability | SQLite as production DB, no worker pool, no caching |
| High | Observability | No structured logs, no metrics, no health check |
| Medium | Deployment | No containerization, no DB migrations, no backup strategy |
| Medium | UX | No real-time updates, no pagination, no error notifications |
| Low | Business Logic | Multi-account support, line-movement detection, risk management |

---

## Recommended Roadmap

1. **Immediate (Week 1)**: Add rate limiting, CORS restrictions, and an audit log. Implement retry logic for WebView operations.
2. **Short-term (Week 2-3)**: Add structured logging, metrics, and health checks. Set up a worker pool to reuse processes.
3. **Medium-term (Month 1)**: Migrate to PostgreSQL; containerize with Docker; implement database migrations.
4. **Long-term (Month 2+)**: Add real-time updates (WebSocket), pagination, and business logic (line-movement detection).

---

## Final Verdict

The architecture is **sound and powerful** – it leverages Bun's latest features (HTTP/3, shared SSL_CTX, `--no-orphans`, native `using`, etc.) to achieve high performance and reliability. However, it is currently an **MVP** – production-ready for small-scale use, but requiring the above additions to serve hundreds of agents across multiple sites. Bun provides the **primitives**; the remaining gaps are **application-level concerns** that can be filled with well-structured code and selected third-party libraries.

---

## 8. Bun v1.3.14 Bug Fixes Relevant to This Platform

These fixes shipped in v1.3.14 and directly affect patterns used in this architecture. Listed here so future implementation doesn't re-encounter the original bugs.

### Bun.spawn fixes

| Fix | Impact on platform |
|-----|---------------------|
| **`Bun.spawn({ ipc })` GC leak** — subprocesses with `ipc: true` were never garbage collected after child exit, leaking the subprocess + stdout/stderr buffers + stdin FileSink for the process lifetime. | **Worker pool**: `ipc: true` is the correct API for parent-child IPC (send/onMessage). This fix means pooled workers won't leak memory. The `ipc: true` option is real — earlier testing showed `child.send` exists but `child.connected` was false; that was the GC bug, not a missing API. |
| **stdin pipe fd leak** — when using `stdin: "pipe"` without reading `.stdin`, the fd leaked until GC. | **render-mermaid.ts**: uses `stdin: "inherit"` (not affected), but worker pool implementations using `stdin: "pipe"` for IPC fallback are now safe. |
| **stdout/stderr pipe GC leak** — subprocess objects weren't GC'd when pipes drained asynchronously after child exit (e.g., grandchild inherits the pipe). | **render-mermaid.ts**: uses `stdio: "inherit"` (not affected). Worker pool with piped stdio is now safe. |
| **`exit` event not firing on Linux** with `stdio: "ignore"` — pidfd poll used EPOLLONESHOT, disarming before user-space could process it. | **Worker pool**: Linux workers with `stdio: "ignore"` now reliably fire exit events. |
| **Caller-owned fd corruption** — extra stdio slots (index >= 3) were incorrectly closed after GC, causing EACCES/EBADF on reuse. | **Worker pool**: passing custom fds as extra stdio slots is now safe. |

### Bun.serve fixes

| Fix | Impact on platform |
|-----|---------------------|
| **`perMessageDeflate` non-boolean crash** — setting it to a number/string/bigint crashed instead of throwing TypeError. | **LiveControl WebSocket**: always pass `perMessageDeflate: false` (boolean), now guarded against type coercion bugs. |
| **ReadableStream sync handler leak** — direct stream handlers writing synchronously leaked ~400 bytes/request. | **LiveControl**: screenshot streaming via ReadableStream no longer leaks. |
| **`server.fetch(string)` URL buffer leak** — intermediate URL was leaked on every call. | **Scheduling**: `Bun.cron` health checks using `server.fetch()` no longer leak. |
| **`server.reload()` WebSocket handler leak** — discarded handler functions were permanently rooted when WebSocket config lacked open/message handlers. | **Hot-reload**: `server.reload()` with partial WebSocket config is now safe. |
| **Chunked body + pending Promise leak** — heap-use-after-free when chunked body exceeded `maxRequestBodySize` and fetch handler returned a pending Promise. | **Task submission**: large task payloads with async fetch handlers are now safe. |

### Other relevant fixes

| Fix | Impact on platform |
|-----|---------------------|
| **`Bun.password.hash()` buffer leak** — hash output buffer wasn't freed after copying to JS string. | **Auth**: `/login` endpoint using `Bun.password.hash()` no longer leaks per call. |
| **TLS cert/key file leak** — passing `Bun.file()` as cert/key/ca leaked one buffer per file per config parse. | **dev-server.ts**: uses `await certFile.text()` (string, not Bun.file directly) — not affected, but good to know the direct-file path is now fixed too. |
| **`Bun.markdown.ansi()` invalid UTF-8 crash** — lone continuation bytes caused a panic. | **Logging**: markdown-to-ANSI rendering (if used for dashboard) is now safe with untrusted input. |
| **RedisClient stuck after failure** — `connect()` didn't recover after reconnection exhaustion or fatal errors. | **Caching/locking**: Redis-based rate limiting and distributed locks can now recover without replacing the client instance. |
| **RedisClient TLS hostname verification** — `rejectUnauthorized: true` silently accepted mismatched/self-signed certs. | **Caching/locking**: Redis TLS connections now properly verify hostnames. |
| **`Bun.S3Client({ queueSize })` panic** — queueSize > 255 crashed, and valid values (1-255) were silently overridden to 255. | **Screenshot storage**: S3 uploads with configurable queue depth are now safe. |
| **`Bun.s3.list()` panic** — prefix/delimiter/continuationToken/startAfter > ~341 chars after URL-encoding crashed. | **Screenshot storage**: listing S3 objects with long prefixes no longer crashes. |
