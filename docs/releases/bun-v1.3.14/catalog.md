# Bun v1.3.14 Release Analysis & Integration Blueprint

Processed from the full blog post: every notable code block categorized by feature, plus a structured integration plan for this repository.

**Artifact pairing:** finer-grained inventory lives here. Pipeline extract at `extracted.json` keeps some features combined (e.g. Bun.Image pipeline+thumbnail, metadata+placeholder) so normalized IDs and adoption notes stay stable. See [Extract ↔ inventory mapping](#extract--inventory-mapping).

Source: https://bun.com/blog/bun-v1.3.14

---

## Code Block Inventory

| # | Feature | Key Code Snippet | Status | Purpose |
|---|---------|------------------|--------|---------|
| 1 | Bun.Image | `await Bun.file("photo.jpg").image().resize(1024,1024).rotate(90).webp({quality:85}).write("thumb.webp")` | Stable | Built-in image processing pipeline |
| 2 | Bun.Image | `new Bun.Image(upload).resize(200).jpeg()` | Stable | Generate thumbnail from upload |
| 3 | Bun.Image | `await new Bun.Image(buf).metadata()` | Stable | Read image metadata |
| 4 | Bun.Image | `await Bun.file("hero.jpg").image().placeholder()` | Stable | Thumbhash blur-up placeholder |
| 5 | Global Virtual Store | `[install] globalStore = true` in `bunfig.toml` | Experimental | Shared global cache via symlinks |
| 6 | HTTP/3 Server | `Bun.serve({ http3: true, tls: { cert, key }, fetch(req) { ... } })` | Highly experimental | Serve HTTP/3 over QUIC |
| 7 | HTTP/3 Only | `Bun.serve({ http3: true, http1: false, ... })` | Highly experimental | Serve only HTTP/3 |
| 8 | HTTP/2 Client | `fetch("https://example.com", { protocol: "http2" })` | Experimental | HTTP/2 fetch client |
| 9 | HTTP/2 Client | `fetch("...", { protocol: "http1.1" })` | Experimental | Force HTTP/1.1 |
| 10 | HTTP/3 Client | `fetch("https://example.com", { protocol: "http3" })` | Highly experimental | HTTP/3 fetch client |
| 11 | fs.watch Rewrite | `fs.watch("./src", { recursive: true }, (event, filename) => { ... })` | Stable | Recursive watch with new dir tracking |
| 12 | --no-orphans | `bun --no-orphans run my-script` / `BUN_FEATURE_FLAG_NO_ORPHANS=1` | Stable | Exit when parent dies |
| 13 | process.execve | `process.execve("/usr/bin/echo", ["echo","hello"], { PATH: process.env.PATH })` | Stable\* | Replace current process (emits ExperimentalWarning) |
| 14 | Bun.Terminal on Windows | `new Bun.Terminal({ cols: 80, rows: 24, onData(data){...} })` + `Bun.spawn({ cmd, terminal })` | Stable | ConPTY terminal support on Windows |
| 15 | using / await using | `using x = { [Symbol.dispose]() { ... } };` | Stable | Native Explicit Resource Management (no lowering) |
| 16 | SIGHUP/SIGBREAK | `process.on("SIGHUP", () => { ... })` / `process.on("SIGBREAK", ...)` | Stable | Windows console control events |
| 17 | WebSocket perMessageDeflate | `new WebSocket("ws://...", { perMessageDeflate: false })` | Stable | Suppress permessage-deflate extension |
| 18 | SSL_CTX Caching | `const db = new SQL("postgres://...?sslmode=require")` | Stable | Shared SSL context for TLS connections |
| 19 | tls.getCACertificates | `tls.getCACertificates("system")` | Stable | Get system CA certs without `--use-system-ca` |
| 20 | Bun.serve performance | `Bun.serve({ http3: true, ... })` benchmark | Experimental | Performance metrics |

\* `process.execve` is stable but emits an `ExperimentalWarning` per process, matching Node.js v24 behavior. Pipeline `extracted.json` keeps `status: "experimental"` to match that warning and existing adoption notes.

Pipeline-only extras (not in the numbered inventory above): `bun publish` README metadata, CLI terminal restore fix.

---

## Extract ↔ inventory mapping

| Inventory # | `extracted.json` block | Notes |
|-------------|------------------------|-------|
| 1–2 | id 1 `Bun.Image` | Combined pipeline + thumbnail Response |
| 3–4 | id 2 `Bun.Image — metadata & placeholder` | Combined; finer API in this catalog |
| 5 | id 3 | — |
| 6, 20 | id 4 | Perf numbers live in purpose/notes; not a separate block |
| 7 | id 18 | Appended HTTP/3-only (`http1: false`) |
| 8 | id 5 | — |
| 9 | id 19 | Appended force `protocol: "http1.1"` |
| 10 | id 6 | — |
| 11–17 | ids 7–13 | — |
| 18 | id 14 | — |
| — | id 15 | bun publish README (automatic) |
| 19 | id 16 | — |
| — | id 17 | CLI terminal restore fix (automatic) |

---

## Feature Deep Dives

### 1. Bun.Image — Built-in Image Processing

**API surface:**

```ts
// Chainable pipeline
await Bun.file("photo.jpg")
  .image()
  .resize(1024, 1024, { fit: "inside" })
  .rotate(90)
  .webp({ quality: 85 })
  .write("thumb.webp");

// Direct constructor
const img = new Bun.Image(upload).resize(200).jpeg();

// Metadata
const meta = await new Bun.Image(buf).metadata();
// { width: 1920, height: 1080, format: "jpeg", ... }

// Blur placeholder (thumbhash)
const placeholder = await Bun.file("hero.jpg").image().placeholder();
```

**Supported formats:**

| Format | macOS | Windows | Linux |
|--------|-------|---------|-------|
| JPEG, PNG, WebP, GIF, BMP | Yes | Yes | Yes |
| TIFF | decode | decode | No |
| HEIC | decode + encode | decode + encode | No |
| AVIF | decode (+ encode Apple Silicon) | decode + encode | No |

**Performance vs sharp 0.34.5:**

| Operation | Bun.Image | sharp | Speedup |
|-----------|-----------|-------|---------|
| metadata() | 0.004 ms | 0.28 ms | 70× |
| 1080p PNG → 400×400 JPEG | 28.6 ms | 39.5 ms | 1.38× |
| 1080p PNG → 800×600 WebP | 82.7 ms | 110.1 ms | 1.33× |
| 4K JPEG → 800×450 JPEG | 35.8 ms | 45.5 ms | 1.27× |
| 4K JPEG → 1920×1080 JPEG | 57.2 ms | 69.9 ms | 1.22× |

**Integration suggestion:**
Create a small utility module `src/utils/image.ts` that wraps common operations (thumbnail, avatar, placeholder) using `Bun.Image`. This replaces `sharp` and eliminates native dependencies.

```ts
// src/utils/image.ts
export async function thumbnail(file: File) {
  return new Response(new Bun.Image(file).resize(200).jpeg());
}
```

**In-repo:** ADOPTED in `src/utils/image.ts` and `scripts/generate-assets.ts`. Placeholder blur-up still optional.

---

### 2. Global Virtual Store — `bun install` Optimization

**Enable:**

```toml
# bunfig.toml
[install]
globalStore = true
```

Or env var: `BUN_INSTALL_GLOBAL_STORE=1 bun install`

**How it works:**
Warm installs (lockfile present, cache warm, node_modules wiped) now perform ~1 symlink per package instead of ~1 file copy. On macOS APFS, this eliminates `clonefileat` calls entirely.

**Benchmark (1,400-package fixture, macOS):**

| Installer | Wall time | System time | clonefileat calls |
|-----------|-----------|-------------|-------------------|
| hoisted | 823 ms | 478 ms | 1,387 |
| isolated (before) | 841 ms | 1,256 ms | 1,387 |
| isolated (after) | **115 ms** | **94 ms** | **0** |

**Eligibility:**
Only packages from immutable cache sources (npm registry, git, tarball) with no trusted lifecycle scripts, and whose entire dependency closure is also eligible, use the global store. Others fall back.

**Integration suggestion:**
Enable `globalStore = true` in CI and local `bunfig.toml` if your project uses `bun install --linker=isolated`. Monitor for correctness; it is still experimental but yields huge CI speedups.

**In-repo:** ADOPTED in `bunfig.toml`.

---

### 3. HTTP/3 (QUIC) Server — `Bun.serve`

**Enable:**

```ts
Bun.serve({
  port: 443,
  tls: { cert, key },
  http3: true, // also listen on UDP/443 for HTTP/3
  fetch(req) {
    return new Response("hi");
  },
});
```

**HTTP/3 only:**

```ts
Bun.serve({
  port: 443,
  tls: { cert, key },
  http3: true,
  http1: false,
  fetch(req) {
    return new Response("h3 only");
  },
});
```

**Performance (Linux x64, single process):**

| Benchmark | HTTP/3 | HTTPS/1.1 | HTTP/1.1 |
|-----------|--------|-----------|----------|
| Static route | 509,135 req/s | 189,130 req/s | 239,476 req/s |
| Dynamic fetch | 283,485 req/s | 142,323 req/s | 171,696 req/s |

**Limitations:**
- WebSocket over HTTP/3 not supported (`server.upgrade()` returns false)
- No 0-RTT, no trailers, no `Expect: 100-continue`
- Powered by lsquic v4.6.2

**Integration suggestion:**
Keep `http3: true` disabled in production until stable. For internal testing, add a separate dev server or behind a feature flag.

**In-repo:** ADOPTED behind `ENABLE_HTTP3=1` (requires `ENABLE_TLS=1`) in `src/server.ts`. HTTP/3-only mode not used.

---

### 4. HTTP/2 & HTTP/3 Clients for `fetch()`

**HTTP/2:**

```ts
// Global opt-in
// BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT=1 bun run app.js
// bun run --experimental-http2-fetch app.js

// Per-request (works without env flag)
const res = await fetch("https://example.com", { protocol: "http2" });
```

**HTTP/3:**

```ts
const res = await fetch("https://example.com/", { protocol: "http3" });
```

**Alt-Svc upgrade for HTTP/3 (opt-in):**

```bash
# CLI flag
bun --experimental-http3-fetch app.ts

# Env var
BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP3_CLIENT=1 bun app.ts
```

**Features supported:**
- Multiplexing, connection coalescing, keep-alive pooling
- Streaming request/response bodies
- AbortSignal, redirects, compression
- HPACK bomb / PING reflection mitigation

**Not supported:**
- HTTP proxies/CONNECT, Unix sockets, server push, cleartext h2c

**Integration suggestion:**
Try HTTP/2 client for high-concurrency internal API calls (e.g., microservice communication). Use `protocol: "http2"` only for endpoints you control. HTTP/3 client remains too risky for production.

**In-repo:** HTTP/2 NOT ADOPTED. HTTP/3 client PARTIAL in `render-mermaid.ts` with fallback.

---

### 5. Rewritten `fs.watch()`

**Key fixes:**
- Recursive watching now tracks new directories (Linux)
- Deleted-and-recreated files emit change events again
- macOS now uses FSEvents exclusively (halves threads)

**Code:**

```ts
import fs from "node:fs";

fs.watch("./src", { recursive: true }, (event, filename) => {
  console.log(event, filename);
});
```

**Integration suggestion:**
Safe to upgrade. If you rely on file watching, this release should reduce bugs and overhead.

**In-repo:** NOT ADOPTED — candidate for config/manifest hot-reload.

---

### 6. `--no-orphans` — Exit When Parent Dies

**Enable any of:**

```bash
bun --no-orphans run my-script
```

```toml
# bunfig.toml
[run]
noOrphans = true
```

```bash
BUN_FEATURE_FLAG_NO_ORPHANS=1 bun run my-script
```

**How it works:**
- Linux: `prctl(PR_SET_PDEATHSIG, SIGKILL)`
- macOS: kqueue watcher for parent pid
- Recursively kills descendants with stop-verify-kill strategy

**Integration suggestion:**
Enable this for all CI runners, Electron supervisors, or any environment where you launch Bun from a parent that may be force-killed. Low overhead, high reliability win.

**In-repo:** ADOPTED on worker subprocesses via `BUN_FEATURE_FLAG_NO_ORPHANS` in `src/workers/pool.ts` (OPEN_TASKS I1 resolved). Not set globally in `bunfig.toml` `[run]`.

---

### 7. `process.execve()`

```ts
process.execve("/usr/bin/echo", ["echo", "hello from execve"], {
  PATH: process.env.PATH,
});
// Never returns on success
```

**Details:**
- Stdio inherited, other FDs close-on-exec
- Signal mask reset
- Throws on Windows and worker threads
- Emits `ExperimentalWarning`

**Integration suggestion:**
Use for process replacement (e.g., restarting a worker with new environment) without spawning a child.

**In-repo:** NOT VIABLE for worker pool — IPC fd is close-on-exec.

---

### 8. Bun.Terminal on Windows (ConPTY)

```ts
const terminal = new Bun.Terminal({
  cols: 80,
  rows: 24,
  onData(data) {
    process.stdout.write(data);
  },
});

const proc = Bun.spawn({
  cmd: ["cmd.exe", "/c", "echo", "hello from ConPTY"],
  terminal,
});

await proc.exited;
terminal.close();
```

**Integration suggestion:**
If you build TUI or interactive CLI tools, this enables Windows support without additional work.

**In-repo:** NOT APPLICABLE — project targets macOS/Linux.

---

### 9. Other Notable Features

- **`using` / `await using` no longer lowered** – faster, cleaner output for Bun targets. ADOPTED in `task-worker.ts`.
- **Windows SIGHUP/SIGBREAK** – handle console close / Ctrl+Break. PARTIAL — SIGHUP in `shutdown.ts`; no SIGBREAK.
- **WebSocket `perMessageDeflate: false`** – suppresses extension header. NOT ADOPTED — candidate for `/ws` endpoints.
- **SSL_CTX caching** – massive memory reduction for TLS connection pools (MongoDB, Postgres, MySQL, fetch keepalive). AUTOMATIC.
- **`tls.getCACertificates('system')`** – works without `--use-system-ca`; no stalls on managed Macs. AUTOMATIC.
- **`bun publish` README metadata** – registry now gets README contents. AUTOMATIC (not publishing).
- **SQLite 3.53.0** – new flags and limits. AUTOMATIC.
- **Cross-language LTO** – ~3.5% HTTP throughput improvement. AUTOMATIC.
- **Faster ESM loading** – ~12% faster module loading. AUTOMATIC.
- **Smaller binary** – up to 18 MB smaller on Windows. AUTOMATIC.
- **Many memory leak & crash fixes** – especially in `Bun.spawn`, `Bun.serve`, `fetch`, TLS, and `bun:sql`. AUTOMATIC.

---

## Integration Checklist

Repo-aware status (from `extracted.json` notes + code inspection):

- [x] **Enable `globalStore = true`** in `bunfig.toml` — done
- [x] **Adopt `Bun.Image`** for server-side image work — done (`src/utils/image.ts`, assets); optional `.placeholder()` still open
- [ ] **Test HTTP/2 client** for internal API communication
- [x] **Enable `--no-orphans`** for workers — done (`pool.ts`); optional global `[run] noOrphans` / CI-wide still open
- [ ] **Update file watching code** to rely on new `fs.watch()` recursive behavior
- [ ] **Consider `process.execve`** — evaluated NOT VIABLE for worker pool IPC
- [ ] **Add `perMessageDeflate: false`** where proxies reject WebSocket extensions
- [ ] **Verify `tls.getCACertificates("system")`** in enterprise environments (automatic API; no app code yet)
- [x] **`bun publish` README metadata** — automatic when publishing; N/A for this app
- [x] **Plan upgrade** — on Bun v1.3.14 path; HTTP/3 remains behind feature flags

---

## Phase Rollout Plan

### Phase 1 — Immediate (Stable Features)

- Upgrade Bun to v1.3.14 in CI and development.
- Enable `globalStore` for faster installs. *(done)*
- Adopt `Bun.Image` for new image processing code. *(done; placeholder optional)*
- Use `--no-orphans` in CI / supervisors. *(workers done)*
- Validate existing `fs.watch` behavior. *(not adopted yet)*

### Phase 2 — Internal Testing (Experimental Features)

- Test HTTP/2 fetch client for internal microservice calls.
- Experiment with HTTP/3 server in a staging environment. *(flagged in `src/server.ts`)*
- Evaluate `process.execve` for worker restarts. *(not viable for current IPC)*
- Monitor SSL_CTX memory reduction in production-like loads.

### Phase 3 — Future (Highly Experimental)

- Re-evaluate HTTP/3 client once more stable.
- Enable HTTP/3 server if performance and reliability meet requirements.
- Migrate remaining image UX (e.g. `.placeholder()`) fully onto `Bun.Image`.

---

## Full Code Block Reference

Deep-dive snippets above are the human-facing reference. Machine-facing blocks: `extracted.json` → `normalized.json` via `bun docs/releases/normalize.ts bun-v1.3.14`. Validate with `bun docs/releases/validate.ts 1.3.14`.
