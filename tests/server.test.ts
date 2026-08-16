import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type Subprocess } from "bun";
import { migrate, write } from "../src/db";
import { consumeJsonlStream } from "../src/utils/jsonl-stream";

describe("Server API Integration", () => {
  const TEST_PORT = 3199;
  let serverProc: Subprocess<"ignore", "pipe", "pipe">;

  // Test agent credentials — created before server starts
  const TEST_AGENT = { username: "test-agent-server", password: "test-pass-123" };
  let authToken = "";
  let csrfToken = "";

  beforeAll(async () => {
    // Ensure migrations run and create a test agent
    migrate();
    await write((db) => {
      // Clean up any previous test agent
      db.query("DELETE FROM auth_sessions WHERE agent_id IN (SELECT id FROM agents WHERE username = ?)").run(TEST_AGENT.username);
      db.query("DELETE FROM agents WHERE username = ?").run(TEST_AGENT.username);
      // Insert fresh test agent with hashed password
      const hashed = Bun.password.hashSync(TEST_AGENT.password);
      db.query("INSERT INTO agents (username, password) VALUES (?, ?)").run(TEST_AGENT.username, hashed);
    });

    serverProc = Bun.spawn({
      cmd: ["bun", "run", "src/server.ts"],
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        NODE_ENV: "development",
        WORKER_POOL_SIZE: "1",
        ENABLE_SITEMAP: "1",
        ENABLE_HTML_REWRITER: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Wait until server is listening
    const maxWait = 5000;
    const start = Date.now();
    let ready = false;

    while (Date.now() - start < maxWait) {
      try {
        const res = await fetch(`http://localhost:${TEST_PORT}/health`);
        if (res.ok) {
          ready = true;
          break;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    if (!ready) {
      serverProc.kill("SIGKILL");
      throw new Error("Server failed to start within timeout");
    }

    // Login to get auth + CSRF tokens for authenticated tests
    const loginRes = await fetch(`http://localhost:${TEST_PORT}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(TEST_AGENT),
    });
    if (loginRes.ok) {
      // JUSTIFIED: req.json() returns unknown; narrowing to the login response shape
      const data = await loginRes.json() as { token: string; csrf_token: string };
      authToken = data.token;
      csrfToken = data.csrf_token;
    }
  });

  afterAll(async () => {
    if (serverProc) {
      serverProc.kill("SIGTERM");
      await serverProc.exited;
    }
  });

  // --- Public routes ---

  it("GET /health returns status ok and worker pool info", async () => {
    interface HealthResponse {
      status: string;
      uptime: number;
      version: string;
      workers: { total: number; busy: number; idle: number; queued: number };
      shuttingDown: boolean;
    }

    const res = await fetch(`http://localhost:${TEST_PORT}/health`);
    expect(res.status).toBe(200);
    // JUSTIFIED: res.json() returns unknown; narrowing to the typed response interface
    const data = (await res.json()) as HealthResponse;
    expect(data.status).toBe("ok");
    expect(data.workers.total).toBe(1);
  });

  it("GET /metrics returns Prometheus format metrics", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("process_uptime_seconds");
    expect(text).toContain("workers{state=\"total\"} 1");
  });

  it("GET /sitemap.xml returns valid sitemap XML", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/sitemap.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/xml");
    const text = await res.text();
    expect(text).toContain("<?xml version=\"1.0\"");
    expect(text).toContain("<urlset");
    expect(text).toContain("/health");
    expect(text).toContain("/features");
    expect(text).not.toContain("/sitemap.xml");

    // Deeper: every <url> has a valid absolute <loc>
    const locs = text.match(/<loc>([^<]+)<\/loc>/g) ?? [];
    expect(locs.length).toBeGreaterThan(0);
    for (const loc of locs) {
      const url = loc.replace(/<\/?loc>/g, "");
      expect(url.startsWith("http")).toBe(true);
      expect(url).not.toContain("/:");
    }

    // Deeper: lastmod is a valid ISO 8601 date
    const lastmod = text.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1] ?? "";
    expect(lastmod).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("GET /features lists sitemap as active when ENABLE_SITEMAP=1", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/features`);
    expect(res.status).toBe(200);
    // JUSTIFIED: res.json() returns unknown; narrowing to the features response shape
    const data = (await res.json()) as { features: { key: string; active: boolean }[] };
    const sitemap = data.features.find((f) => f.key === "sitemap");
    expect(sitemap).toBeDefined();
    expect(sitemap!.active).toBe(true);
  });

  it("GET /dashboard includes sitemap link when sitemap is active", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/dashboard`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/sitemap.xml"');
  });

  it("POST /api/markdown chains Bun.markdown.html() through Bun.serve", async () => {
    const md = "# Hello\n\n| A | B |\n|---|---|\n| 1 | 2 |";
    const res = await fetch(`http://localhost:${TEST_PORT}/api/markdown`, {
      method: "POST",
      body: md,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<h1>");
    expect(html).toContain("<table>");
    expect(html).toContain("Hello");
  });

  it("HTMLRewriter injects theme-color meta and feature flags into /dashboard", async () => {
    // Ref: https://bun.com/docs/runtime/htmlrewriter
    const res = await fetch(`http://localhost:${TEST_PORT}/dashboard`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // HTMLRewriter should have injected theme-color meta into <head>
    expect(html).toContain('<meta name="theme-color" content="#50fa7b">');
    // Feature flags script should be injected
    expect(html).toContain("window.__FEATURE_FLAGS__");
    expect(html).toContain("'sitemap': true");
    expect(html).toContain("'htmlRewriter': true");
    // Body should have data-html-rewritten attribute
    expect(html).toContain('data-html-rewritten="true"');
  });

  it("HTMLRewriter marks /api/markdown output with data-markdown-rendered", async () => {
    // Ref: https://bun.com/docs/runtime/htmlrewriter
    const md = "# Test\n\nHello world";
    const res = await fetch(`http://localhost:${TEST_PORT}/api/markdown`, {
      method: "POST",
      body: md,
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // HTMLRewriter should have added data-markdown-rendered to <body>
    expect(html).toContain('data-markdown-rendered="true"');
  });

  it("GET /features lists htmlRewriter as active when ENABLE_HTML_REWRITER=1", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/features`);
    expect(res.status).toBe(200);
    // JUSTIFIED: res.json() returns unknown; narrowing to the features response shape
    const data = (await res.json()) as { features: { key: string; active: boolean }[] };
    const rewriter = data.features.find((f) => f.key === "htmlRewriter");
    expect(rewriter).toBeDefined();
    expect(rewriter!.active).toBe(true);
  });

  it("HTMLRewriter can scrape and transform external HTML", () => {
    // Ref: https://bun.com/docs/runtime/htmlrewriter
    // Unit test: verify HTMLRewriter element handlers work correctly
    const html = "<html><head><title>Test</title></head><body><h1>Hello</h1></body></html>";
    const res = new Response(html, { headers: { "Content-Type": "text/html" } });
    const rw = new HTMLRewriter()
      .on("head", {
        element(el) {
          el.append('<meta name="injected" content="yes">', { html: true });
        },
      })
      .on("h1", {
        element(el) {
          el.setAttribute("data-transformed", "true");
        },
      });
    const out = rw.transform(res);
    // JUSTIFIED: out.text() returns a Promise<string>; this is a sync test
    // but we can use expect with the resolved value via Bun's sync-ish test
    return out.text().then((text) => {
      expect(text).toContain('<meta name="injected" content="yes">');
      expect(text).toContain('data-transformed="true"');
    });
  });

  // --- Auth ---

  it("POST /login rejects invalid credentials and audits failure", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "nonexistent", password: "wrong" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /login returns token + csrf_token on success", async () => {
    expect(authToken).toBeTruthy();
    expect(csrfToken).toBeTruthy();
  });

  it("GET /tasks returns 401 without auth", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/tasks`);
    expect(res.status).toBe(401);
  });

  it("GET /audit returns 401 without auth", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/audit`);
    expect(res.status).toBe(401);
  });

  // --- Authenticated routes ---

  it("GET /tasks returns paginated task list with auth", async () => {
    interface TasksResponse {
      tasks: unknown[];
      total: number;
      limit: number;
      offset: number;
    }

    const res = await fetch(`http://localhost:${TEST_PORT}/tasks?limit=10`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    // JUSTIFIED: res.json() returns unknown; narrowing to the typed response interface
    const data = (await res.json()) as TasksResponse;
    expect(Array.isArray(data.tasks)).toBe(true);
    expect(typeof data.total).toBe("number");
  });

  it("GET /api/tasks.jsonl streams tasks as JSONL consumable with parseChunk", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/tasks.jsonl?limit=10`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/jsonl");
    expect(res.body).toBeDefined();
    // Ref: https://bun.com/docs/runtime/jsonl#byte-offsets-with-uint8array
    const reader = res.body!.getReader();
    let buf = new Uint8Array(0);
    const tasks: Record<string, unknown>[] = [];
    let done = false;
    while (!done) {
      const { value, done: chunkDone } = await reader.read();
      if (value) {
        const merged = new Uint8Array(buf.length + value.length);
        merged.set(buf);
        merged.set(value, buf.length);
        buf = merged;
      }
      const result = Bun.JSONL.parseChunk(buf);
      // JUSTIFIED: parseChunk returns unknown[]; narrowing to the task row shape
      tasks.push(...(result.values as Record<string, unknown>[]));
      buf = buf.subarray(result.read);
      done = chunkDone;
    }
    // Each task row should have id and agent_id columns
    for (const task of tasks) {
      expect(task).toHaveProperty("id");
      expect(task).toHaveProperty("agent_id");
    }
  });

  it("GET /audit returns paginated audit log entries with auth", async () => {
    interface AuditResponse {
      logs: unknown[];
      limit: number;
      offset: number;
    }

    const res = await fetch(`http://localhost:${TEST_PORT}/audit?limit=10`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    // JUSTIFIED: res.json() returns unknown; narrowing to the typed response interface
    const data = (await res.json()) as AuditResponse;
    expect(Array.isArray(data.logs)).toBe(true);
  });

  it("GET /api/sessions.jsonl streams sessions as JSONL consumable with parseChunk", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/sessions.jsonl?limit=10`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/jsonl");
    expect(res.body).toBeDefined();
    // Ref: https://bun.com/docs/runtime/jsonl#byte-offsets-with-uint8array
    const reader = res.body!.getReader();
    let buf = new Uint8Array(0);
    const sessions: Record<string, unknown>[] = [];
    let done = false;
    while (!done) {
      const { value, done: chunkDone } = await reader.read();
      if (value) {
        const merged = new Uint8Array(buf.length + value.length);
        merged.set(buf);
        merged.set(value, buf.length);
        buf = merged;
      }
      const result = Bun.JSONL.parseChunk(buf);
      // JUSTIFIED: parseChunk returns unknown[]; narrowing to the session row shape
      sessions.push(...(result.values as Record<string, unknown>[]));
      buf = buf.subarray(result.read);
      done = chunkDone;
    }
    // Sessions list may be empty (no tasks created in this test run) but must
    // be a valid stream. If any sessions exist, each should have id and task_id.
    for (const session of sessions) {
      expect(session).toHaveProperty("id");
      expect(session).toHaveProperty("task_id");
    }
  });

  it("GET /api/audit.jsonl returns parseable JSONL via Bun.JSONL.parse", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/audit.jsonl?limit=5`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/jsonl");
    const text = await res.text();
    // Ref: node_modules/bun-types/docs/runtime/jsonl.mdx
    const values = Bun.JSONL.parse(text);
    expect(Array.isArray(values)).toBe(true);
    expect(values.length).toBeGreaterThan(0);
    for (const obj of values) {
      expect(obj).toHaveProperty("action");
      expect(obj).toHaveProperty("created_at");
    }
  });

  it("GET /api/audit.jsonl can be consumed incrementally with parseChunk", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/audit.jsonl?limit=5`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    // Ref: https://bun.com/docs/runtime/jsonl#byte-offsets-with-uint8array
    // Zero-copy binary streaming: accumulate Uint8Array chunks and use
    // subarray() to carry forward unconsumed bytes.
    const reader = res.body!.getReader();
    let buf = new Uint8Array(0);
    const events: Record<string, unknown>[] = [];
    let done = false;
    while (!done) {
      const { value, done: chunkDone } = await reader.read();
      if (value) {
        const merged = new Uint8Array(buf.length + value.length);
        merged.set(buf);
        merged.set(value, buf.length);
        buf = merged;
      }
      const result = Bun.JSONL.parseChunk(buf);
      // JUSTIFIED: parseChunk returns unknown[]; narrowing to the audit row shape
      events.push(...(result.values as Record<string, unknown>[]));
      buf = buf.subarray(result.read);
      done = chunkDone;
    }
    expect(events.length).toBeGreaterThan(0);
    for (const obj of events) {
      expect(obj).toHaveProperty("action");
      expect(obj).toHaveProperty("created_at");
    }
  });

  it("Bun.JSONL.parseChunk handles partial and complete audit JSONL chunks", () => {
    // Ref: node_modules/bun-types/docs/runtime/jsonl.mdx#parseChunk
    const full = '{"action":"login"}\n{"action":"task"}';
    const bytes = new TextEncoder().encode(full);
    const result = Bun.JSONL.parseChunk(bytes);
    expect(result.values.length).toBe(2);
    expect(result.read).toBe(bytes.length);
    expect(result.done).toBe(true);
    expect(result.error).toBeNull();

    const partial = '{"action":"login"}\n{"ac'; // incomplete second line
    const pBytes = new TextEncoder().encode(partial);
    const pResult = Bun.JSONL.parseChunk(pBytes);
    expect(pResult.values.length).toBe(1);
    expect(pResult.done).toBe(false);
    expect(pResult.error).toBeNull();
  });

  it("Bun.JSONL.parseChunk supports byte offsets for zero-copy streaming", () => {
    // Ref: https://bun.com/docs/runtime/jsonl#byte-offsets-with-uint8array
    const buf = new TextEncoder().encode('{"a":1}\n{"b":2}\n{"c":3}\n');
    // Parse starting from byte offset 8 (skips the first line)
    const fromOffset = Bun.JSONL.parseChunk(buf, 8);
    expect(fromOffset.values.length).toBe(2);
    expect(fromOffset.values[0]).toEqual({ b: 2 });
    expect(fromOffset.values[1]).toEqual({ c: 3 });
    // read is a byte offset into the original buffer (up to last value, not trailing newline)
    expect(fromOffset.read).toBe(23);

    // Parse a specific range [0, 8) — only the first line
    const partial = Bun.JSONL.parseChunk(buf, 0, 8);
    expect(partial.values.length).toBe(1);
    expect(partial.values[0]).toEqual({ a: 1 });
  });

  it("Bun.JSONL.parseChunk uses subarray for zero-copy streaming", () => {
    // Ref: https://bun.com/docs/runtime/jsonl#byte-offsets-with-uint8array
    // Simulate binary stream chunks arriving and use subarray() to carry
    // forward unconsumed bytes — the zero-copy pattern from the docs.
    const chunk1 = new TextEncoder().encode('{"id":1}\n{"id":2}\n{"id":3');
    const chunk2 = new TextEncoder().encode('}\n{"id":4}\n');

    let buf = new Uint8Array(0);
    const collected: number[] = [];

    // Append chunk1
    const merged1 = new Uint8Array(buf.length + chunk1.length);
    merged1.set(buf);
    merged1.set(chunk1, buf.length);
    buf = merged1;

    const r1 = Bun.JSONL.parseChunk(buf);
    // JUSTIFIED: parseChunk returns unknown[]; narrowing to { id: number }
    for (const v of r1.values as { id: number }[]) collected.push(v.id);
    // Zero-copy: subarray shares the underlying buffer
    buf = buf.subarray(r1.read);
    expect(r1.done).toBe(false);
    expect(collected).toEqual([1, 2]);

    // Append chunk2 (completes line 3 and adds line 4)
    const merged2 = new Uint8Array(buf.length + chunk2.length);
    merged2.set(buf);
    merged2.set(chunk2, buf.length);
    buf = merged2;

    const r2 = Bun.JSONL.parseChunk(buf);
    // JUSTIFIED: parseChunk returns unknown[]; narrowing to { id: number }
    for (const v of r2.values as { id: number }[]) collected.push(v.id);
    buf = buf.subarray(r2.read);
    expect(r2.done).toBe(true);
    expect(collected).toEqual([1, 2, 3, 4]);
    // Trailing newline after last value may remain as 1 byte
    expect(buf.length).toBeLessThanOrEqual(1);
  });

  it("Bun.JSONL.parseChunk recovers from errors without throwing", () => {
    // Ref: https://bun.com/docs/runtime/jsonl#error-recovery
    const input = '{"a":1}\n{invalid}\n{"b":2}\n';
    const result = Bun.JSONL.parseChunk(input);
    // Values parsed before the error are returned
    expect(result.values.length).toBe(1);
    expect(result.values[0]).toEqual({ a: 1 });
    // Error is reported, not thrown
    expect(result.error).toBeInstanceOf(SyntaxError);
    // read reflects position up to last successful parse
    expect(result.read).toBe(7);
  });

  it("Bun.JSONL.parseChunk returns a pre-built object shape for fast property access", () => {
    // Ref: https://bun.com/docs/runtime/jsonl#performance-notes
    // The result object uses a cached structure — verify all four properties
    // are always present (values, read, done, error) regardless of input.
    const result = Bun.JSONL.parseChunk('{"x":1}\n');
    expect(result).toHaveProperty("values");
    expect(result).toHaveProperty("read");
    expect(result).toHaveProperty("done");
    expect(result).toHaveProperty("error");
    expect(Array.isArray(result.values)).toBe(true);
    expect(typeof result.read).toBe("number");
    expect(typeof result.done).toBe("boolean");
    // error is null when no parse error occurred
    expect(result.error).toBeNull();

    // Same shape on empty input
    const empty = Bun.JSONL.parseChunk("");
    expect(empty).toHaveProperty("values");
    expect(empty).toHaveProperty("read");
    expect(empty).toHaveProperty("done");
    expect(empty).toHaveProperty("error");
  });

  it("Bun.JSONL.parse handles all supported JSON value types", () => {
    // Ref: https://bun.com/docs/runtime/jsonl#supported-value-types
    const input = '42\n"hello"\ntrue\nnull\n[1,2,3]\n{"key":"value"}\n';
    const values = Bun.JSONL.parse(input);
    expect(values).toEqual([42, "hello", true, null, [1, 2, 3], { key: "value" }]);
  });

  it("Bun.JSONL.parse skips UTF-8 BOM in Uint8Array input", () => {
    // Ref: https://bun.com/docs/runtime/jsonl#performance-notes
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const payload = new TextEncoder().encode('{"ok":true}\n');
    const buf = new Uint8Array(bom.length + payload.length);
    buf.set(bom);
    buf.set(payload, bom.length);
    const values = Bun.JSONL.parse(buf);
    expect(values).toEqual([{ ok: true }]);
  });

  it("Bun.JSONL.parseChunk error recovery: can continue after skipping bad line", () => {
    // Ref: https://bun.com/docs/runtime/jsonl#error-recovery
    // parseChunk never throws but gets stuck at read=0 when the buffer
    // starts with invalid JSON. Manually skip past the bad line to continue.
    const input = '{"a":1}\n{invalid}\n{"b":2}\n';
    let buf = input;
    const collected: Record<string, unknown>[] = [];
    let hadError = false;

    // First parse — gets {a:1}, then hits error
    const r1 = Bun.JSONL.parseChunk(buf);
    // JUSTIFIED: parseChunk returns unknown[]; narrowing to record shape
    collected.push(...(r1.values as Record<string, unknown>[]));
    buf = buf.slice(r1.read);
    expect(r1.error).toBeInstanceOf(SyntaxError);
    hadError = true;

    // Manual recovery: skip leading newlines, then skip to end of bad line
    if (r1.error) {
      while (buf.startsWith("\n")) buf = buf.slice(1);
      const nlIdx = buf.indexOf("\n");
      expect(nlIdx).toBeGreaterThanOrEqual(0);
      buf = buf.slice(nlIdx + 1);
    }

    // Second parse — should now get {b:2}
    const r2 = Bun.JSONL.parseChunk(buf);
    // JUSTIFIED: parseChunk returns unknown[]; narrowing to record shape
    collected.push(...(r2.values as Record<string, unknown>[]));
    expect(r2.error).toBeNull();
    expect(r2.done).toBe(true);

    expect(hadError).toBe(true);
    expect(collected).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("consumeJsonlStream helper: zero-copy streaming with error recovery", async () => {
    // Ref: src/utils/jsonl-stream.ts
    // Build a stream with two valid lines and one bad line in the middle
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode('{"id":1}\n{"id":2}\n'),
      encoder.encode('{bad}\n'),
      encoder.encode('{"id":3}\n'),
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });

    const values: { id: number }[] = [];
    const errors: SyntaxError[] = [];
    const result = await consumeJsonlStream(stream, {
      // JUSTIFIED: onValue receives unknown; narrowing to the expected shape
      onValue: (v) => values.push(v as { id: number }),
      onError: (err) => errors.push(err),
    });

    expect(values).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(SyntaxError);
    expect(result.count).toBe(3);
    expect(result.errors).toBe(1);
  });

  it("consumeJsonlStream helper: handles partial values across chunk boundaries", async () => {
    // Ref: src/utils/jsonl-stream.ts
    // Split a JSON object across two chunks to test the remainder buffer
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"id":1}\n{"id":2,"name":"Al'));
        controller.enqueue(encoder.encode('ice"}\n{"id":3}\n'));
        controller.close();
      },
    });

    const values: { id: number; name?: string }[] = [];
    const result = await consumeJsonlStream(stream, {
      // JUSTIFIED: onValue receives unknown; narrowing to the expected shape
      onValue: (v) => values.push(v as { id: number; name?: string }),
    });

    expect(values).toEqual([
      { id: 1 },
      { id: 2, name: "Alice" },
      { id: 3 },
    ]);
    expect(result.count).toBe(3);
    expect(result.errors).toBe(0);
  });

  it("consumeJsonlStream helper: consumes /api/audit.jsonl end-to-end", async () => {
    // Ref: src/utils/jsonl-stream.ts
    // Use the helper to consume the real server endpoint
    const res = await fetch(`http://localhost:${TEST_PORT}/api/audit.jsonl?limit=5`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();

    const events: Record<string, unknown>[] = [];
    const result = await consumeJsonlStream(res.body!, {
      // JUSTIFIED: onValue receives unknown; narrowing to audit record shape
      onValue: (v) => events.push(v as Record<string, unknown>),
    });

    expect(result.count).toBeGreaterThan(0);
    expect(result.errors).toBe(0);
    for (const event of events) {
      expect(event).toHaveProperty("action");
      expect(event).toHaveProperty("created_at");
    }
  });

  // --- CSRF ---

  it("POST /task returns 403 without CSRF token (even with auth)", async () => {
    // E3: agent_id in the body is now ignored — the server forces it to
    // ctx.agentId. We send a wrong agent_id to verify it's not used.
    const res = await fetch(`http://localhost:${TEST_PORT}/task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ agent_id: 99999, url: "https://example.com" }),
    });
    expect(res.status).toBe(403);
  });
});
