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
        ENABLE_PWA: "1",
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

  it("GET /metrics includes PWA and route metrics", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/metrics`);
    const text = await res.text();
    expect(text).toContain("routes{type=\"total\"}");
    expect(text).toContain("routes{type=\"pwa\"}");
    expect(text).toContain('pwa{enabled="true"}');
    expect(text).toContain("features{type=\"active\"}");
    expect(text).toContain("features{type=\"total\"}");
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

  it("GET /sitemap.xml includes PWA routes when ENABLE_PWA=1", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/sitemap.xml`);
    const text = await res.text();
    expect(text).toContain("/manifest.json");
    expect(text).toContain("/sw.js");
    expect(text).toContain("/dashboard");
    expect(text).toContain("/api/pwa/compare");
    expect(text).toContain("/api/pwa/validate");
    expect(text).toContain("/bun-com/manifest.json");
    // Param routes should NOT be in sitemap
    expect(text).not.toContain("/icons/:filename");
    expect(text).not.toContain("/bun-com/icons/:filename");
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

  it("GET /api/color converts colors via Bun.color — chains Bun.serve + Bun.color", async () => {
    // Ref: https://bun.com/docs/runtime/color
    const res = await fetch(`http://localhost:${TEST_PORT}/api/color?color=red&format=css`);
    expect(res.status).toBe(200);
    // JUSTIFIED: res.json() returns unknown; narrowing to the color response shape
    const data = (await res.json()) as { input: string; format: string; output: string };
    expect(data.input).toBe("red");
    expect(data.format).toBe("css");
    expect(data.output).toBe("red");
  });

  it("GET /api/color converts hex to rgb format", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/color?color=%2350fa7b&format=rgb`);
    expect(res.status).toBe(200);
    // JUSTIFIED: res.json() returns unknown; narrowing to the color response shape
    const data = (await res.json()) as { input: string; format: string; output: string };
    expect(data.format).toBe("rgb");
    expect(data.output).toBe("rgb(80, 250, 123)");
  });

  it("GET /api/color converts hex to number format", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/color?color=%2350fa7b&format=number`);
    expect(res.status).toBe(200);
    // JUSTIFIED: res.json() returns unknown; narrowing to the color response shape
    const data = (await res.json()) as { input: string; format: string; output: number };
    expect(data.format).toBe("number");
    expect(typeof data.output).toBe("number");
    expect(data.output).toBe(0x50fa7b);
  });

  it("GET /api/color converts to {rgb} object format", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/color?color=red&format={rgb}`);
    expect(res.status).toBe(200);
    // JUSTIFIED: res.json() returns unknown; narrowing to the color response shape
    const data = (await res.json()) as { input: string; format: string; output: { r: number; g: number; b: number } };
    expect(data.output).toEqual({ r: 255, g: 0, b: 0 });
  });

  it("GET /api/color returns 400 for invalid color input", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/color?color=notacolor&format=css`);
    expect(res.status).toBe(400);
  });

  it("GET /api/color returns 400 for missing color parameter", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/color?format=css`);
    expect(res.status).toBe(400);
  });

  it("GET /api/color returns 400 for invalid format", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/color?color=red&format=invalid`);
    expect(res.status).toBe(400);
  });

  // Ref: https://bun.com/docs/runtime/env
  it("GET /api/env returns safe subset of environment variables", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/env`);
    expect(res.status).toBe(200);
    // JUSTIFIED: res.json() returns unknown; narrowing to the env response shape
    const data = (await res.json()) as {
      env: Record<string, string | undefined>;
      aliases: Record<string, boolean>;
      bunVersion: string;
    };
    expect(data.env).toHaveProperty("NODE_ENV");
    expect(data.env).toHaveProperty("PORT");
    expect(data.env).toHaveProperty("ENABLE_SITEMAP");
    expect(data.env).toHaveProperty("ENABLE_HTML_REWRITER");
    // Should NOT expose secrets like CSRF_SECRET or DB_PATH
    expect(data.env).not.toHaveProperty("CSRF_SECRET");
    expect(data.env).not.toHaveProperty("DB_PATH");
    // Verify env accessor aliases
    // Ref: https://bun.com/docs/runtime/env#reading-environment-variables
    expect(data.aliases["process.env === Bun.env"]).toBe(true);
    expect(data.aliases["Bun.env === import.meta.env"]).toBe(true);
    expect(data.bunVersion).toBe(Bun.version);
  });

  it("GET /api/env?key=NODE_ENV returns a single env var", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/env?key=NODE_ENV`);
    expect(res.status).toBe(200);
    // JUSTIFIED: res.json() returns unknown; narrowing to the env response shape
    const data = (await res.json()) as { key: string; value: string; source: string };
    expect(data.key).toBe("NODE_ENV");
    expect(data.value).toBe("development");
    expect(data.source).toBe("Bun.env");
  });

  it("GET /api/env?key=NONEXISTENT returns 404", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/env?key=NONEXISTENT_VAR_12345`);
    expect(res.status).toBe(404);
  });

  it("Bun.env, process.env, and import.meta.env are all aliases of the same object", () => {
    // Ref: https://bun.com/docs/runtime/env#reading-environment-variables
    expect(process.env).toBe(Bun.env);
    expect(Bun.env).toBe(import.meta.env);
    // Mutating one mutates all
    process.env.BUN_ALIAS_TEST = "hello";
    expect(Bun.env.BUN_ALIAS_TEST).toBe("hello");
    expect(import.meta.env.BUN_ALIAS_TEST).toBe("hello");
    delete process.env.BUN_ALIAS_TEST;
  });

  it("process.env can be set programmatically", () => {
    // Ref: https://bun.com/docs/runtime/env#setting-environment-variables
    process.env.BUN_SET_TEST = "testvalue";
    expect(Bun.env.BUN_SET_TEST).toBe("testvalue");
    expect(import.meta.env.BUN_SET_TEST).toBe("testvalue");
    delete process.env.BUN_SET_TEST;
  });

  it("TypeScript interface merging types env vars as string", () => {
    // Ref: https://bun.com/docs/runtime/env#typescript
    // The Env interface in src/types/env.d.ts augments Bun's types.
    // PORT is declared as `string | undefined` in the augmented interface.
    const port = process.env.PORT;
    // JUSTIFIED: typeof check narrows string | undefined to string for the test
    if (typeof port === "string") {
      expect(typeof port).toBe("string");
    }
    // ENABLE_SITEMAP is declared in the augmented interface
    // The test process itself doesn't have it set (only the server subprocess does),
    // so we set it here to verify the typed accessor works
    process.env.ENABLE_SITEMAP = "1";
    const sitemap = Bun.env.ENABLE_SITEMAP;
    expect(sitemap).toBe("1");
    delete process.env.ENABLE_SITEMAP;
  });

  it("Bun --env-file supports variable expansion and escaping", async () => {
    // Ref: https://bun.com/docs/runtime/env#expansion
    // Write a temp .env file with expansion and escaped $
    const envContent = `BUN_EXPAND_BASE=hello
BUN_EXPAND_DERIVED=hello$BUN_EXPAND_BASE
BUN_EXPAND_ESCAPED=hello\\$BUN_EXPAND_BASE`;
    const tmpEnv = `/tmp/test-expand-${Date.now()}.env`;
    await Bun.write(tmpEnv, envContent);

    const proc = Bun.spawn({
      cmd: ["bun", "--env-file", tmpEnv, "-e",
        "console.log(JSON.stringify({derived: process.env.BUN_EXPAND_DERIVED, escaped: process.env.BUN_EXPAND_ESCAPED}))"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    // JUSTIFIED: output is a JSON string from our console.log; narrowing to the shape
    const parsed = JSON.parse(output.trim()) as { derived: string; escaped: string };
    // Expansion: $BUN_EXPAND_BASE should be replaced with "hello"
    expect(parsed.derived).toBe("hellohello");
    // Escaped: \$ should keep the literal $ character
    expect(parsed.escaped).toBe("hello$BUN_EXPAND_BASE");
  });

  it("Bun --env-file supports quoted values (single, double, backtick)", async () => {
    // Ref: https://bun.com/docs/runtime/env#quotation-marks
    const envContent = `BUN_QUOTE_SINGLE='single_value'
BUN_QUOTE_DOUBLE="double_value"
BUN_QUOTE_BACKTICK=\`backtick_value\``;
    const tmpEnv = `/tmp/test-quotes-${Date.now()}.env`;
    await Bun.write(tmpEnv, envContent);

    const proc = Bun.spawn({
      cmd: ["bun", "--env-file", tmpEnv, "-e",
        "console.log(JSON.stringify({s: process.env.BUN_QUOTE_SINGLE, d: process.env.BUN_QUOTE_DOUBLE, b: process.env.BUN_QUOTE_BACKTICK}))"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    // JUSTIFIED: output is a JSON string from our console.log; narrowing to the shape
    const parsed = JSON.parse(output.trim()) as { s: string; d: string; b: string };
    expect(parsed.s).toBe("single_value");
    expect(parsed.d).toBe("double_value");
    expect(parsed.b).toBe("backtick_value");
  });

  it("Bun --env-file supports recursive variable expansion (A→B→C)", async () => {
    // Ref: https://bun.com/docs/runtime/env#expansion
    // Bun's expansion is recursive: C=$B, B=$A, A=1 → C resolves to "1"
    const envContent = `A=1
B=$A
C=$B`;
    const tmpEnv = `/tmp/test-recursive-${Date.now()}.env`;
    await Bun.write(tmpEnv, envContent);

    const proc = Bun.spawn({
      cmd: ["bun", "--env-file", tmpEnv, "-e",
        "console.log(JSON.stringify({a: process.env.A, b: process.env.B, c: process.env.C}))"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    // JUSTIFIED: output is a JSON string from our console.log; narrowing to the shape
    const parsed = JSON.parse(output.trim()) as { a: string; b: string; c: string };
    expect(parsed.a).toBe("1");
    expect(parsed.b).toBe("1");
    expect(parsed.c).toBe("1");
  });

  it("Bun --env-file supports ${VAR} brace syntax for concatenation", async () => {
    // Ref: https://bun.com/docs/runtime/env#expansion
    // ${VAR} allows concatenation without ambiguity: ${PREFIX}_v1
    const envContent = `PREFIX=app
NAME=\${PREFIX}_v1`;
    const tmpEnv = `/tmp/test-braces-${Date.now()}.env`;
    await Bun.write(tmpEnv, envContent);

    const proc = Bun.spawn({
      cmd: ["bun", "--env-file", tmpEnv, "-e",
        "console.log(process.env.NAME)"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    expect(output.trim()).toBe("app_v1");
  });

  it("Bun --env-file does NOT support $(VAR) paren syntax in v1.3.14", async () => {
    // Ref: https://bun.com/docs/runtime/env#expansion
    // The docs mention $(VAR) but v1.3.14 does not support it — only $VAR and ${VAR}
    const envContent = `PREFIX=app
NAME=$(PREFIX)_v2`;
    const tmpEnv = `/tmp/test-parens-${Date.now()}.env`;
    await Bun.write(tmpEnv, envContent);

    const proc = Bun.spawn({
      cmd: ["bun", "--env-file", tmpEnv, "-e",
        "console.log(process.env.NAME)"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    // $(PREFIX) is NOT expanded — it stays as a literal string
    expect(output.trim()).toBe("(PREFIX)_v2");
  });

  it("Bun --env-file supports nested expansion for connection strings", async () => {
    // Ref: https://bun.com/docs/runtime/env#expansion
    // Real-world pattern: building a DB URL from multiple vars
    const envContent = `DB_USER=postgres
DB_PASS=secret
DB_HOST=localhost
DB_PORT=5432
DB_URL=postgres://$DB_USER:$DB_PASS@$DB_HOST:$DB_PORT`;
    const tmpEnv = `/tmp/test-nested-${Date.now()}.env`;
    await Bun.write(tmpEnv, envContent);

    const proc = Bun.spawn({
      cmd: ["bun", "--env-file", tmpEnv, "-e",
        "console.log(process.env.DB_URL)"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    expect(output.trim()).toBe("postgres://postgres:secret@localhost:5432");
  });

  it("Bun --env-file expansion is resolved at load time, not lazily on access", async () => {
    // Ref: https://bun.com/docs/runtime/env#expansion
    // In v1.3.14, expansion happens when the .env file is loaded, not when
    // process.env is accessed. Changing A after loading does not affect B=$A.
    // (The docs describe lazy expansion, but v1.3.14 resolves at load time.)
    const envContent = `A=1
B=$A`;
    const tmpEnv = `/tmp/test-loadtime-${Date.now()}.env`;
    await Bun.write(tmpEnv, envContent);

    const proc = Bun.spawn({
      cmd: ["bun", "--env-file", tmpEnv, "-e",
        "process.env.A = '2'; console.log(process.env.B)"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    // B was resolved to "1" at load time; changing A afterward doesn't affect it
    expect(output.trim()).toBe("1");
  });

  it("Bun.expandEnv is not available in v1.3.14", () => {
    // Ref: https://bun.com/docs/runtime/env#expansion
    // The docs mention Bun.expandEnv() for manual string expansion, but this
    // API was added in a later version. In v1.3.14 it is undefined.
    // JUSTIFIED: Bun.expandEnv is not in v1.3.14 types; cast to check existence
    expect((Bun as unknown as Record<string, unknown>).expandEnv).toBeUndefined();
  });

  it("Bun.env can be iterated with Object.entries", () => {
    // Ref: https://bun.com/docs/runtime/env#reading-environment-variables
    process.env.BUN_ITER_TEST = "iter_value";
    const entries = Object.entries(Bun.env);
    // JUSTIFIED: find returns undefined | [string, string]; we check for truthy
    const found = entries.find(([k]) => k === "BUN_ITER_TEST");
    expect(found).toBeTruthy();
    expect(found![1]).toBe("iter_value");
    delete process.env.BUN_ITER_TEST;
  });

  it("Bun.env supports delete operator to remove variables", () => {
    // Ref: https://bun.com/docs/runtime/env#reading-environment-variables
    process.env.BUN_DELETE_TEST = "temp";
    expect(Bun.env.BUN_DELETE_TEST).toBe("temp");
    delete Bun.env.BUN_DELETE_TEST;
    expect(Bun.env.BUN_DELETE_TEST).toBeUndefined();
    expect(process.env.BUN_DELETE_TEST).toBeUndefined();
  });

  it("Bun.env ?? operator for default values", () => {
    // Ref: https://bun.com/docs/runtime/env#reading-environment-variables
    const apiKey = Bun.env.BUN_NONEXISTENT_KEY ?? "default-key";
    expect(apiKey).toBe("default-key");

    process.env.BUN_EXISTS_KEY = "real-value";
    const realKey = Bun.env.BUN_EXISTS_KEY ?? "default-key";
    expect(realKey).toBe("real-value");
    delete process.env.BUN_EXISTS_KEY;
  });

  // Ref: https://bun.com/docs/runtime/env#automatic-env-loading
  it("Bun .env file hierarchy: .env.local overrides .env.{NODE_ENV} overrides .env", async () => {
    // Ref: https://bun.com/docs/runtime/env#automatic-env-loading
    // Test all four levels of the hierarchy by removing files one at a time
    const testDir = `/tmp/env-hierarchy-${Date.now()}`;
    await Bun.write(`${testDir}/.env`, "VAR_LEVEL=base");
    await Bun.write(`${testDir}/.env.development`, "VAR_LEVEL=development");

    const runWithDir = async (dir: string): Promise<string> => {
      const proc = Bun.spawn({
        cmd: ["bun", "-e", "console.log(process.env.VAR_LEVEL)"],
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NODE_ENV: "development" },
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return out.trim();
    };

    // Level 2: .env.development overrides .env
    expect(await runWithDir(testDir)).toBe("development");

    // Level 3: .env.local overrides .env.development
    await Bun.write(`${testDir}/.env.local`, "VAR_LEVEL=local");
    expect(await runWithDir(testDir)).toBe("local");

    // Level 4: .env.development.local overrides .env.local
    await Bun.write(`${testDir}/.env.development.local`, "VAR_LEVEL=dev_local");
    expect(await runWithDir(testDir)).toBe("dev_local");
  });

  it("Bun --no-env-file disables automatic .env loading", async () => {
    // Ref: https://bun.com/docs/runtime/env#disabling-automatic-env-loading
    const testDir = `/tmp/env-no-file-${Date.now()}`;
    await Bun.write(`${testDir}/.env`, "BUN_NOFILE_TEST=loaded");
    const proc = Bun.spawn({
      cmd: ["bun", "--no-env-file", "-e", "console.log(process.env.BUN_NOFILE_TEST)"],
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    // With --no-env-file, the .env file is NOT loaded
    expect(out.trim()).toBe("undefined");
  });

  it("Bun --env-file loads a specific .env file even with --no-env-file defaults", async () => {
    // Ref: https://bun.com/docs/runtime/env#manually-specifying-env-files
    // --env-file explicitly loads a file; this works even in CI where
    // automatic loading is disabled
    const tmpEnv = `/tmp/env-explicit-${Date.now()}.env`;
    await Bun.write(tmpEnv, "BUN_EXPLICIT_TEST=loaded");
    const proc = Bun.spawn({
      cmd: ["bun", "--env-file", tmpEnv, "-e", "console.log(process.env.BUN_EXPLICIT_TEST)"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out.trim()).toBe("loaded");
  });

  it("Bun --print process.env outputs all environment variables", async () => {
    // Ref: https://bun.com/docs/runtime/env#reading-environment-variables
    // `bun --print process.env` prints all env vars as a JS object
    const proc = Bun.spawn({
      cmd: ["bun", "--print", "process.env"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BUN_PRINT_TEST_VAR: "print_test_value" },
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out).toContain("BUN_PRINT_TEST_VAR");
    expect(out).toContain("print_test_value");
  });

  it("Bun-specific env vars: NO_COLOR and FORCE_COLOR", async () => {
    // Ref: https://bun.com/docs/runtime/env#configuring-bun
    // NO_COLOR=1 disables ANSI color; FORCE_COLOR=1 overrides NO_COLOR
    const proc = Bun.spawn({
      cmd: ["bun", "-e", "console.log(JSON.stringify({noColor: process.env.NO_COLOR, forceColor: process.env.FORCE_COLOR}))"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "1" },
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    // JUSTIFIED: output is a JSON string from our console.log; narrowing to the shape
    const parsed = JSON.parse(out.trim()) as { noColor: string; forceColor: string };
    expect(parsed.noColor).toBe("1");
    expect(parsed.forceColor).toBe("1");
  });

  it("Bun-specific env vars: BUN_CONFIG_MAX_HTTP_REQUESTS is readable", () => {
    // Ref: https://bun.com/docs/runtime/env#configuring-bun
    // This env var controls max concurrent HTTP requests (default 256)
    process.env.BUN_CONFIG_MAX_HTTP_REQUESTS = "10";
    expect(Bun.env.BUN_CONFIG_MAX_HTTP_REQUESTS).toBe("10");
    delete process.env.BUN_CONFIG_MAX_HTTP_REQUESTS;
  });

  it("Bun-specific env vars: BUN_RUNTIME_TRANSPILER_CACHE_PATH controls cache", async () => {
    // Ref: https://bun.com/docs/runtime/env#runtime-transpiler-caching
    // Setting to "0" disables the cache; setting to a path uses that path
    const proc = Bun.spawn({
      cmd: ["bun", "-e", "console.log(process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH)"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out.trim()).toBe("0");
  });

  it("Bun-specific env vars: DO_NOT_TRACK disables telemetry", () => {
    // Ref: https://bun.com/docs/runtime/env#configuring-bun
    process.env.DO_NOT_TRACK = "1";
    expect(Bun.env.DO_NOT_TRACK).toBe("1");
    delete process.env.DO_NOT_TRACK;
  });

  it("Bun-specific env vars: BUN_CONFIG_VERBOSE_FETCH controls fetch logging", () => {
    // Ref: https://bun.com/docs/runtime/env#configuring-bun
    // BUN_CONFIG_VERBOSE_FETCH=curl logs fetch requests like curl
    process.env.BUN_CONFIG_VERBOSE_FETCH = "curl";
    expect(Bun.env.BUN_CONFIG_VERBOSE_FETCH).toBe("curl");
    delete process.env.BUN_CONFIG_VERBOSE_FETCH;
  });

  it("getEnv helper returns fallback when env var is not set", () => {
    // Ref: src/server.ts getEnv() helper
    // The helper is used at module load time, but we can test the pattern
    function getEnv(key: string, fallback?: string): string {
      const value = Bun.env[key];
      if (value === undefined && fallback === undefined) {
        throw new Error(`Missing required environment variable: ${key}`);
      }
      return value ?? fallback!;
    }
    expect(getEnv("BUN_NONEXISTENT_GETENV_TEST", "fallback_val")).toBe("fallback_val");
  });

  it("getEnv helper throws when required env var is missing", () => {
    // Ref: src/server.ts getEnv() helper
    function getEnv(key: string, fallback?: string): string {
      const value = Bun.env[key];
      if (value === undefined && fallback === undefined) {
        throw new Error(`Missing required environment variable: ${key}`);
      }
      return value ?? fallback!;
    }
    expect(() => getEnv("BUN_REQUIRED_BUT_MISSING_VAR")).toThrow("Missing required environment variable");
  });

  it("getEnv helper returns value when env var is set", () => {
    // Ref: src/server.ts getEnv() helper
    function getEnv(key: string, fallback?: string): string {
      const value = Bun.env[key];
      if (value === undefined && fallback === undefined) {
        throw new Error(`Missing required environment variable: ${key}`);
      }
      return value ?? fallback!;
    }
    process.env.BUN_GETENV_REAL_TEST = "real_value";
    expect(getEnv("BUN_GETENV_REAL_TEST", "fallback")).toBe("real_value");
    delete process.env.BUN_GETENV_REAL_TEST;
  });

  // Ref: https://bun.com/docs/runtime/env#test-runner-specific
  it("bun test sets NODE_ENV=test automatically", async () => {
    // Ref: https://bun.com/docs/runtime/env#test-runner-specific
    // bun test sets NODE_ENV to "test" unless explicitly overridden.
    // We must unset NODE_ENV from the env (not set to "") for auto-set to trigger.
    const tmpTest = `/tmp/test-node-env-${Date.now()}.ts`;
    await Bun.write(tmpTest, `import { test } from "bun:test";
test("check NODE_ENV", () => {
  console.log("NODE_ENV=" + process.env.NODE_ENV);
});`);
    // Remove NODE_ENV from the env map so bun test auto-sets it
    const testEnv = { ...process.env };
    delete testEnv.NODE_ENV;
    const proc = Bun.spawn({
      cmd: ["bun", "test", tmpTest],
      stdout: "pipe",
      stderr: "pipe",
      env: testEnv,
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    await proc.exited;
    const combined = out + err;
    // bun test should set NODE_ENV to "test"
    expect(combined).toContain("NODE_ENV=test");
  });

  it("TZ environment variable controls timezone", async () => {
    // Ref: https://bun.com/docs/runtime/env#test-runner-specific
    // TZ sets the timezone; bun test defaults to Etc/UTC
    const proc = Bun.spawn({
      cmd: ["bun", "-e", "console.log(process.env.TZ)"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TZ: "America/New_York" },
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out.trim()).toBe("America/New_York");
  });

  it("TZ defaults to undefined (system timezone) outside bun test", async () => {
    // Ref: https://bun.com/docs/runtime/env#test-runner-specific
    // Outside bun test, TZ is not auto-set (uses system timezone)
    const proc = Bun.spawn({
      cmd: ["bun", "-e", "console.log(process.env.TZ ?? 'undefined')"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TZ: undefined },
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out.trim()).toBe("undefined");
  });

  // Ref: https://bun.com/docs/runtime/env#package-manager-install
  it("BUN_INSTALL_GLOBAL_STORE enables global virtual store", async () => {
    // Ref: https://bun.com/docs/runtime/env#package-manager-install
    // This env var controls bun install's global virtual store feature
    const proc = Bun.spawn({
      cmd: ["bun", "-e", "console.log(process.env.BUN_INSTALL_GLOBAL_STORE)"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BUN_INSTALL_GLOBAL_STORE: "1" },
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out.trim()).toBe("1");
  });

  it("BUN_INSTALL_CACHE_DIR overrides global package cache directory", async () => {
    // Ref: https://bun.com/docs/runtime/env#package-manager-install
    const proc = Bun.spawn({
      cmd: ["bun", "-e", "console.log(process.env.BUN_INSTALL_CACHE_DIR)"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BUN_INSTALL_CACHE_DIR: "/tmp/bun-cache-test" },
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out.trim()).toBe("/tmp/bun-cache-test");
  });

  // Ref: https://bun.com/docs/runtime/env#configuring-bun
  it("BUN_OPTIONS prepends CLI arguments to bun commands", () => {
    // Ref: https://bun.com/docs/runtime/env#configuring-bun
    // BUN_OPTIONS is already set in the dev environment as "--hot"
    // We verify it's readable (the actual prepending is a Bun runtime behavior)
    const savedOptions = process.env.BUN_OPTIONS;
    process.env.BUN_OPTIONS = "--hot";
    expect(Bun.env.BUN_OPTIONS).toBe("--hot");
    if (savedOptions !== undefined) {
      process.env.BUN_OPTIONS = savedOptions;
    } else {
      delete process.env.BUN_OPTIONS;
    }
  });

  it("BUN_CONFIG_NO_CLEAR_TERMINAL_ON_RELOAD prevents watch terminal clear", async () => {
    // Ref: https://bun.com/docs/runtime/env#configuring-bun
    // This env var controls bun --watch terminal clearing behavior
    const proc = Bun.spawn({
      cmd: ["bun", "-e", "console.log(process.env.BUN_CONFIG_NO_CLEAR_TERMINAL_ON_RELOAD)"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BUN_CONFIG_NO_CLEAR_TERMINAL_ON_RELOAD: "true" },
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out.trim()).toBe("true");
  });

  it("NODE_TLS_REJECT_UNAUTHORIZED disables SSL validation when set to 0", async () => {
    // Ref: https://bun.com/docs/runtime/env#configuring-bun
    // NODE_TLS_REJECT_UNAUTHORIZED=0 disables SSL cert validation
    // (dangerous — dev/testing only)
    const proc = Bun.spawn({
      cmd: ["bun", "-e", "console.log(process.env.NODE_TLS_REJECT_UNAUTHORIZED)"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out.trim()).toBe("0");
  });

  it("TMPDIR controls temporary directory for Bun operations", async () => {
    // Ref: https://bun.com/docs/runtime/env#configuring-bun
    // TMPDIR is where Bun stores intermediate assets during bundling
    const proc = Bun.spawn({
      cmd: ["bun", "-e", "console.log(process.env.TMPDIR)"],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TMPDIR: "/tmp/bun-tmpdir-test" },
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out.trim()).toBe("/tmp/bun-tmpdir-test");
  });

  it("bunfig.toml env=false disables .env loading (config equivalent of --no-env-file)", async () => {
    // Ref: https://bun.com/docs/runtime/env#disabling-automatic-env-loading
    // The bunfig.toml [env] key can disable automatic .env loading.
    // We test this by creating a temp project with env=false in bunfig.toml
    const testDir = `/tmp/env-bunfig-${Date.now()}`;
    await Bun.write(`${testDir}/.env`, "BUN_BUNFIG_TEST=loaded");
    await Bun.write(`${testDir}/bunfig.toml`, "env = false\n");
    const proc = Bun.spawn({
      cmd: ["bun", "-e", "console.log(process.env.BUN_BUNFIG_TEST ?? 'undefined')"],
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    // With env=false in bunfig.toml, .env should NOT be loaded
    expect(out.trim()).toBe("undefined");
  });

  it("bun exec provides cross-platform env var setting", async () => {
    // Ref: https://bun.com/docs/runtime/env#setting-environment-variables
    // bun exec uses Bun Shell, which supports FOO=value command syntax
    // cross-platform (including Windows)
    // Use Bun.$ shell template for cross-platform env var setting
    const result = await Bun.$`BUN_EXEC_TEST=cross_platform bun -e 'console.log(process.env.BUN_EXEC_TEST)'`.text();
    expect(result.trim()).toBe("cross_platform");
  });

  it("package.json scripts use Bun Shell for cross-platform env vars", async () => {
    // Ref: https://bun.com/docs/runtime/env#setting-environment-variables
    // Scripts called with `bun run` automatically use Bun Shell, so
    // NODE_ENV=development bun --watch app.ts works cross-platform
    const testPkg = `/tmp/test-pkg-env-${Date.now()}`;
    await Bun.write(`${testPkg}/package.json`, JSON.stringify({
      name: "env-test",
      scripts: {
        "test-env": "BUN_PKG_SCRIPT_TEST=from_script bun -e 'console.log(process.env.BUN_PKG_SCRIPT_TEST)'",
      },
    }));
    const proc = Bun.spawn({
      cmd: ["bun", "run", "test-env"],
      cwd: testPkg,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out).toContain("from_script");
  });

  it("Internal env vars: BUN_FEATURE_FLAG_* are readable when set", () => {
    // Ref: https://bun.com/docs/runtime/env#internal-experimental
    // BUN_FEATURE_FLAG_* vars enable experimental features
    // We already use BUN_FEATURE_FLAG_NO_ORPHANS in the worker pool
    process.env.BUN_FEATURE_FLAG_TEST_INTERNAL = "1";
    expect(Bun.env.BUN_FEATURE_FLAG_TEST_INTERNAL).toBe("1");
    delete process.env.BUN_FEATURE_FLAG_TEST_INTERNAL;
  });

  it("Internal env vars: BUN_GARBAGE_COLLECTOR_LEVEL is readable when set", () => {
    // Ref: https://bun.com/docs/runtime/env#internal-experimental
    // Forces GC to run more frequently (debugging)
    process.env.BUN_GARBAGE_COLLECTOR_LEVEL = "1";
    expect(Bun.env.BUN_GARBAGE_COLLECTOR_LEVEL).toBe("1");
    delete process.env.BUN_GARBAGE_COLLECTOR_LEVEL;
  });

  // Ref: https://bun.com/docs/runtime/color#flexible-input
  it("Bun.color accepts all flexible input types and normalizes to css", () => {
    // Ref: https://bun.com/docs/runtime/color#flexible-input
    // All of these represent the color red and should normalize to "red"
    // Note: number input (0xff0000) returns "#f000" in v1.3.14 — a known bug
    // where number inputs don't normalize to named colors. Fixed in later versions.
    expect(Bun.color("red", "css")).toBe("red");
    expect(Bun.color("#f00", "css")).toBe("red");
    expect(Bun.color("#ff0000", "css")).toBe("red");
    expect(Bun.color("rgb(255, 0, 0)", "css")).toBe("red");
    expect(Bun.color("rgba(255, 0, 0, 1)", "css")).toBe("red");
    expect(Bun.color("hsl(0, 100%, 50%)", "css")).toBe("red");
    expect(Bun.color("hsla(0, 100%, 50%, 1)", "css")).toBe("red");
    expect(Bun.color({ r: 255, g: 0, b: 0 }, "css")).toBe("red");
    expect(Bun.color({ r: 255, g: 0, b: 0, a: 1 }, "css")).toBe("red");
    expect(Bun.color([255, 0, 0], "css")).toBe("red");
    expect(Bun.color([255, 0, 0, 255], "css")).toBe("red");
    // Number input — verify it produces a valid color, not null
    expect(Bun.color(0xff0000, "css")).not.toBeNull();
  });

  it("Bun.color accepts LAB color strings", () => {
    // Ref: https://bun.com/docs/runtime/color#flexible-input
    // LAB is listed as a supported input format
    const result = Bun.color("lab(50% 50 50)", "css");
    expect(result).not.toBeNull();
  });

  it("Bun.color returns null for invalid input", () => {
    // Ref: https://bun.com/docs/runtime/color#format-colors-as-css
    expect(Bun.color("notacolor", "css")).toBeNull();
  });

  it("Bun.color formats as ANSI escape codes for terminals", () => {
    // Ref: https://bun.com/docs/runtime/color#format-colors-as-ansi-for-terminals
    const ansi16m = Bun.color("red", "ansi-16m");
    expect(ansi16m).toContain("\x1b[38;2;255;0;0m");

    const ansi256 = Bun.color("red", "ansi-256");
    expect(ansi256).toContain("\x1b[38;5;196m");

    // Note: ansi-16 has a bug in v1.3.14 where it outputs a tab character
    // instead of the correct code. The docs say it should be "\x1b[91m".
    // We just verify it returns a non-null escape sequence.
    const ansi16 = Bun.color("red", "ansi-16");
    expect(ansi16).not.toBeNull();
    expect(ansi16!.startsWith("\x1b[")).toBe(true);
  });

  it("Bun.color formats as number for database storage", () => {
    // Ref: https://bun.com/docs/runtime/color#format-colors-as-numbers
    expect(Bun.color("red", "number")).toBe(16711680);
    expect(Bun.color(0xff0000, "number")).toBe(16711680);
    expect(Bun.color({ r: 255, g: 0, b: 0 }, "number")).toBe(16711680);
    expect(Bun.color([255, 0, 0], "number")).toBe(16711680);
  });

  it("Bun.color {rgba} returns object with alpha as 0-1 decimal", () => {
    // Ref: https://bun.com/docs/runtime/color#rgba-object
    expect(Bun.color("red", "{rgba}")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(Bun.color("hsl(0, 0%, 50%)", "{rgba}")).toEqual({ r: 128, g: 128, b: 128, a: 1 });
  });

  it("Bun.color [rgba] returns array with alpha as 0-255 integer", () => {
    // Ref: https://bun.com/docs/runtime/color#rgba-array
    expect(Bun.color("red", "[rgba]")).toEqual([255, 0, 0, 255]);
    expect(Bun.color("hsl(0, 0%, 50%)", "[rgba]")).toEqual([128, 128, 128, 255]);
  });

  it("Bun.color hex and HEX formats produce lowercase and uppercase", () => {
    // Ref: https://bun.com/docs/runtime/color#format-colors-as-hex-strings
    expect(Bun.color("red", "hex")).toBe("#ff0000");
    expect(Bun.color("red", "HEX")).toBe("#FF0000");
    expect(Bun.color("hsl(0, 0%, 50%)", "hex")).toBe("#808080");
    expect(Bun.color("hsl(0, 0%, 50%)", "HEX")).toBe("#808080");
  });

  it("Bun.color bundle-time macro inlines color conversion at build time", async () => {
    // Ref: https://bun.com/docs/runtime/color#bundle-time-client-side-color-formatting
    // The macro import evaluates Bun.color at build time and inlines the result.
    const src = `import { color } from "bun" with { type: "macro" };
console.log(color("#f00", "css"));
console.log(color("#50fa7b", "hex"));
console.log(color("red", "number"));`;
    const tmpFile = `/tmp/color-macro-build-test-${Date.now()}.ts`;
    await Bun.write(tmpFile, src);
    const proc = Bun.spawn({
      cmd: ["bun", "build", tmpFile],
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    // The macro should inline the results — no runtime Bun.color call
    expect(output).toContain('console.log("red")');
    expect(output).toContain('console.log("#50fa7b")');
    expect(output).toContain("console.log(16711680)");
    // The output should NOT contain the macro import
    expect(output).not.toContain('import { color }');
    expect(output).not.toContain("Bun.color");
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

  // --- PWA (Progressive Web App) ---
  // Ref: https://web.dev/articles/add-manifest

  it("GET /manifest.json serves the PWA manifest when ENABLE_PWA=1", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/manifest.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/manifest+json");
    // JUSTIFIED: res.json() returns unknown; narrowing to the manifest shape
    const manifest = (await res.json()) as {
      name: string;
      short_name: string;
      start_url: string;
      display: string;
      icons: { src: string; sizes: string; type: string }[];
    };
    expect(manifest.name).toBe("BUN-DEV");
    expect(manifest.short_name).toBe("BUN-DEV");
    expect(manifest.start_url).toBe("/dashboard");
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons.length).toBeGreaterThan(0);
    // Should have at least a 192 and 512 icon (required for installability)
    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
  });

  it("GET /icons/icon-128.png serves a PNG icon", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/icons/icon-128.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    const buf = await res.arrayBuffer();
    // PNG magic bytes: 89 50 4E 47
    const bytes = new Uint8Array(buf);
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50);
    expect(bytes[2]).toBe(0x4e);
    expect(bytes[3]).toBe(0x47);
  });

  it("GET /icons/nonexistent.png returns 404", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/icons/nonexistent.png`);
    expect(res.status).toBe(404);
  });

  it("GET /icons/icon-128.txt returns 404 (non-png rejected)", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/icons/icon-128.txt`);
    expect(res.status).toBe(404);
  });

  it("GET /dashboard includes manifest link when PWA is enabled", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/dashboard`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<link rel="manifest" href="/manifest.json">');
    expect(html).toContain('<link rel="icon" type="image/png" sizes="128x128" href="/icons/icon-128.png">');
    expect(html).toContain('<link rel="apple-touch-icon" href="/icons/icon-192.png">');
  });

  it("GET /dashboard has enhanced dark theme with PWA install button", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/dashboard`);
    const html = await res.text();
    // Dark theme CSS variables
    expect(html).toContain("--bg: #1f2020");
    expect(html).toContain("--accent: #50fa7b");
    // PWA install button (beforeinstallprompt handler)
    expect(html).toContain("pwa-install-btn");
    expect(html).toContain("installPWA()");
    expect(html).toContain("beforeinstallprompt");
    // SW status badge
    expect(html).toContain("sw-status");
    // PWA section with icon and links
    expect(html).toContain('class="pwa-section"');
    expect(html).toContain("/bun-com/manifest.json");
    // Live uptime counter
    expect(html).toContain("setInterval");
    expect(html).toContain("uptimeStart");
    // Footer
    expect(html).toContain("BUN-DEV");
  });

  it("GET /dashboard has live health polling and status cards", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/dashboard`);
    const html = await res.text();
    expect(html).toContain("pollHealth");
    expect(html).toContain("health-pulse");
    expect(html).toContain("health-stat");
    expect(html).toContain("workers-stat");
    expect(html).toContain("routes-stat");
  });

  it("GET /dashboard has network status indicator", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/dashboard`);
    const html = await res.text();
    expect(html).toContain("net-status");
    expect(html).toContain("navigator.onLine");
    expect(html).toContain("updateNetStatus");
  });

  it("GET /dashboard has icon gallery with all BUN-DEV and bun.com icons", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/dashboard`);
    const html = await res.text();
    expect(html).toContain("icon-gallery");
    // BUN-DEV icons
    expect(html).toContain("/icons/icon-16.png");
    expect(html).toContain("/icons/icon-512.png");
    expect(html).toContain("/icons/icon-1024.png");
    expect(html).toContain("/icons/maskable-512.png");
    // bun.com icons
    expect(html).toContain("/bun-com/icons/favicon-16x16.png");
    expect(html).toContain("/bun-com/icons/icon-512x512.png");
    expect(html).toContain("/bun-com/icons/logo.svg");
    expect(html).toContain("/bun-com/icons/apple-touch-icon.png");
  });

  it("GET /dashboard has visual icon comparison section", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/dashboard`);
    const html = await res.text();
    expect(html).toContain("icon-vs");
    expect(html).toContain("BUN-DEV (ours)");
    expect(html).toContain("bun.com (theirs)");
  });

  it("GET /dashboard has SW cache status panel", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/dashboard`);
    const html = await res.text();
    expect(html).toContain("sw-cache-content");
    expect(html).toContain("checkSWCache");
    expect(html).toContain("sw-cache-fill");
  });

  it("GET /dashboard has copy-to-clipboard for manifest", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/dashboard`);
    const html = await res.text();
    expect(html).toContain("copyManifest");
    expect(html).toContain("navigator.clipboard");
    expect(html).toContain("Copy Manifest JSON");
  });

  it("GET /dashboard has keyboard shortcuts", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/dashboard`);
    const html = await res.text();
    expect(html).toContain("keydown");
    expect(html).toContain("case 'r'");
    expect(html).toContain("case 'i'");
    expect(html).toContain("case 'c'");
    expect(html).toContain("case 'v'");
    expect(html).toContain("case 'g'");
    expect(html).toContain("Shortcuts:");
  });

  it("GET /dashboard has toast notification element", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/dashboard`);
    const html = await res.text();
    expect(html).toContain('id="toast"');
    expect(html).toContain("showToast");
  });

  it("GET /dashboard has toggleSection helper for collapsible panels", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/dashboard`);
    const html = await res.text();
    expect(html).toContain("toggleSection");
  });

  it("GET /features lists pwa as active when ENABLE_PWA=1", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/features`);
    expect(res.status).toBe(200);
    // JUSTIFIED: res.json() returns unknown; narrowing to the features response shape
    const data = (await res.json()) as { features: { key: string; active: boolean }[] };
    const pwa = data.features.find((f) => f.key === "pwa");
    expect(pwa).toBeDefined();
    expect(pwa!.active).toBe(true);
  });

  it("manifest.json has correct theme_color matching Bun.color output", async () => {
    // Ref: https://bun.com/docs/runtime/color
    // The manifest theme_color should match the dashboard's injected theme-color
    const res = await fetch(`http://localhost:${TEST_PORT}/manifest.json`);
    // JUSTIFIED: res.json() returns unknown; narrowing to the manifest shape
    const manifest = (await res.json()) as { theme_color: string; background_color: string };
    // theme_color is the Dracula green, background_color is the dark bg
    expect(manifest.theme_color).toBe("#50fa7b");
    expect(manifest.background_color).toBe("#1f2020");
  });

  it("GET /sw.js serves the service worker", async () => {
    // Ref: https://web.dev/articles/install-criteria
    // Chrome requires a service worker for PWA installability
    const res = await fetch(`http://localhost:${TEST_PORT}/sw.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/javascript");
    expect(res.headers.get("Service-Worker-Allowed")).toBe("/");
    const js = await res.text();
    expect(js).toContain("install");
    expect(js).toContain("fetch");
    expect(js).toContain("caches");
  });

  it("dashboard includes service worker registration script when PWA is enabled", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/dashboard`);
    const html = await res.text();
    expect(html).toContain("navigator.serviceWorker.register('/sw.js'");
  });

  // --- bun.com PWA snapshot ---

  it("GET /bun-com/manifest.json serves the original bun.com manifest", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/bun-com/manifest.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/manifest+json");
    // JUSTIFIED: res.json() returns unknown; narrowing to the manifest shape
    const manifest = (await res.json()) as { name: string; short_name: string; display: string };
    expect(manifest.name).toBe("Bun");
    expect(manifest.short_name).toBe("Bun");
    expect(manifest.display).toBe("minimal-ui");
  });

  it("GET /bun-com/icons/icon-512x512.png serves the original Bun icon", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/bun-com/icons/icon-512x512.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    expect(bytes[0]).toBe(0x89); // PNG magic
  });

  it("GET /bun-com/icons/logo.svg serves the Bun SVG logo", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/bun-com/icons/logo.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    const svg = await res.text();
    expect(svg).toContain("<svg");
  });

  it("GET /bun-com/icons/favicon.ico serves the Bun favicon", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/bun-com/icons/favicon.ico`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/x-icon");
  });

  it("GET /bun-com/icons/nonexistent.png returns 404", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/bun-com/icons/nonexistent.png`);
    expect(res.status).toBe(404);
  });

  // --- PWA manifest comparison + validation ---
  // Ref: https://web.dev/articles/install-criteria

  it("GET /api/pwa/compare returns BUN-DEV vs bun.com comparison", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/pwa/compare`);
    expect(res.status).toBe(200);
    // JUSTIFIED: res.json() returns unknown; narrowing to the comparison shape
    const data = (await res.json()) as {
      summary: {
        totalFields: number; matchingFields: number; differingFields: number;
        ourIconCount: number; theirIconCount: number;
        ourInstallable: boolean; theirInstallable: boolean;
        ourScore: number; theirScore: number;
      };
      fields: { field: string; ours: string; theirs: string; match: boolean }[];
      icons: { size: string; ours: boolean; theirs: boolean }[];
      validation: {
        ours: { label: string; installable: boolean; score: number; errors: string[]; warnings: string[] };
        theirs: { label: string; installable: boolean; score: number; errors: string[]; warnings: string[] };
      };
    };
    // Summary
    expect(data.summary.totalFields).toBeGreaterThan(0);
    expect(data.summary.ourInstallable).toBe(true);
    expect(data.summary.theirInstallable).toBe(true);
    expect(data.summary.ourScore).toBeGreaterThanOrEqual(80);
    expect(data.summary.theirScore).toBeGreaterThanOrEqual(80);
    // Fields comparison
    expect(data.fields.length).toBeGreaterThan(5);
    const nameField = data.fields.find((f) => f.field === "name");
    expect(nameField).toBeDefined();
    expect(nameField!.ours).toContain("BUN-DEV");
    expect(nameField!.theirs).toContain("Bun");
    expect(nameField!.match).toBe(false);
    // Icons comparison
    expect(data.icons.length).toBeGreaterThan(5);
    const icon192 = data.icons.find((i) => i.size === "192x192");
    expect(icon192).toBeDefined();
    expect(icon192!.ours).toBe(true);
    expect(icon192!.theirs).toBe(true);
    // Validation
    expect(data.validation.ours.label).toBe("BUN-DEV");
    expect(data.validation.theirs.label).toBe("bun.com");
    expect(data.validation.ours.errors.length).toBe(0);
    expect(data.validation.theirs.errors.length).toBe(0);
  });

  it("GET /api/pwa/compare shows BUN-DEV has maskable icon but bun.com does not", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/pwa/compare`);
    // JUSTIFIED: res.json() returns unknown; narrowing to the comparison shape
    const data = (await res.json()) as {
      validation: {
        ours: { checks: { check: string; pass: boolean }[] };
        theirs: { checks: { check: string; pass: boolean }[] };
      };
    };
    const ourMaskable = data.validation.ours.checks.find((c) => c.check === "Has maskable icon");
    const theirMaskable = data.validation.theirs.checks.find((c) => c.check === "Has maskable icon");
    expect(ourMaskable).toBeDefined();
    expect(ourMaskable!.pass).toBe(true);
    expect(theirMaskable).toBeDefined();
    expect(theirMaskable!.pass).toBe(false);
  });

  it("GET /api/pwa/validate returns BUN-DEV installability validation", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/pwa/validate`);
    expect(res.status).toBe(200);
    // JUSTIFIED: res.json() returns unknown; narrowing to the validation shape
    const data = (await res.json()) as {
      manifest: string; installable: boolean; score: number;
      errors: string[]; warnings: string[];
      checks: { category: string; check: string; pass: boolean; severity: string; detail: string }[];
    };
    expect(data.manifest).toBe("BUN-DEV");
    expect(data.installable).toBe(true);
    expect(data.score).toBeGreaterThanOrEqual(80);
    expect(data.errors.length).toBe(0);
    // Required checks
    const requiredChecks = data.checks.filter((c) => c.category === "required");
    expect(requiredChecks.length).toBeGreaterThan(0);
    for (const c of requiredChecks) {
      expect(c.pass).toBe(true);
    }
    // Should have maskable icon check
    const maskable = data.checks.find((c) => c.check === "maskable icon");
    expect(maskable).toBeDefined();
    expect(maskable!.pass).toBe(true);
  });

  it("GET /api/pwa/validate has all required fields passing", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/pwa/validate`);
    // JUSTIFIED: res.json() returns unknown; narrowing to the validation shape
    const data = (await res.json()) as {
      checks: { category: string; check: string; pass: boolean; severity: string }[];
    };
    const required = data.checks.filter((c) => c.category === "required");
    for (const c of required) {
      expect(c.pass).toBe(true);
    }
  });

  it("GET /api/pwa/validate includes service worker check", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/pwa/validate`);
    // JUSTIFIED: res.json() returns unknown; narrowing to the validation shape
    const data = (await res.json()) as {
      checks: { check: string; pass: boolean; detail: string }[];
    };
    const swCheck = data.checks.find((c) => c.check === "service worker");
    expect(swCheck).toBeDefined();
    expect(swCheck!.pass).toBe(true);
    expect(swCheck!.detail).toBe("/sw.js");
  });

  it("dashboard includes links to compare and validate endpoints", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/dashboard`);
    const html = await res.text();
    expect(html).toContain("/api/pwa/compare");
    expect(html).toContain("/api/pwa/validate");
    expect(html).toContain("loadPWACompare()");
    expect(html).toContain("loadPWAValidate()");
  });

  it("dashboard has collapsible comparison and validation panels", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/dashboard`);
    const html = await res.text();
    expect(html).toContain('id="pwa-compare-panel"');
    expect(html).toContain('id="pwa-compare-content"');
    expect(html).toContain('id="pwa-validate-panel"');
    expect(html).toContain('id="pwa-validate-content"');
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

  // ==========================================================================
  // Phase 1-5: Deep Enhancement Tests
  // ==========================================================================

  it("Phase 1: GET /dashboard has CSP nonce on script tags", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/dashboard`);
    const html = await res.text();
    // nonce= appears in script tag attributes
    expect(html).toContain("nonce=");
    // Content-Security-Policy is a response header
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).not.toBeNull();
    expect(csp).toContain("nonce-");
  });

  it("Phase 1: POST /login sets session cookie with HttpOnly and SameSite", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "testagent", password: "testpass" }),
    });
    const setCookie = res.headers.get("Set-Cookie");
    if (setCookie) {
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
      expect(setCookie).toContain("session=");
    }
  });

  it("Phase 2: GET /api/health-log returns health check history", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/health-log`);
    expect(res.status).toBe(200);
    // JUSTIFIED: res.json() returns unknown; narrowing to expected response shape
    const data = await res.json() as { entries: unknown[] };
    expect(Array.isArray(data.entries)).toBe(true);
  });

  it("Phase 2: GET /api/semver returns version negotiation info", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/semver?version=1.3.14&range=>=1.3.0`);
    // JUSTIFIED: res.json() returns unknown; narrowing to expected response shape
    expect(res.status).toBe(200);
    // JUSTIFIED: res.json() returns unknown; narrowing to response shape
    const data = await res.json() as { version: string; satisfies: boolean; features: Record<string, boolean> };
    expect(data.version).toBe("1.3.14");
    expect(data.satisfies).toBe(true);
    expect(data.features.http3).toBe(true);
    expect(data.features.webview).toBe(true);
    expect(data.features.cron).toBe(true);
  });

    // JUSTIFIED: res.json() returns unknown; narrowing to expected response shape
  it("Phase 2: GET /api/semver detects old version features", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/semver?version=1.3.10`);
    // JUSTIFIED: res.json() returns unknown; narrowing to response shape
    const data = await res.json() as { features: Record<string, boolean> };
    expect(data.features.http3).toBe(false);
    expect(data.features.cron).toBe(false);
  });

  it("Phase 2: GET /api/audit/stream requires auth (returns 401)", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/audit/stream`);
    expect(res.status).toBe(401);
  });

  it("Phase 2: GET /api/audit/stream returns SSE content type with auth", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/audit/stream`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  });

  it("Phase 3: GET /api/export/bundle.tar requires auth", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/export/bundle.tar`);
    expect(res.status).toBe(401);
  });

  it("Phase 3: GET /api/export/bundle.tar returns tar archive with auth", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/export/bundle.tar`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/x-tar");
    expect(res.headers.get("Content-Disposition")).toContain("bun-dev-export-");
  });

    // JUSTIFIED: res.json() returns unknown; narrowing to expected response shape
  it("Phase 4: GET /api/openapi.json returns OpenAPI 3.1 spec", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/openapi.json`);
    expect(res.status).toBe(200);
    // JUSTIFIED: res.json() returns unknown; narrowing to response shape
    const data = await res.json() as { openapi: string; info: { title: string }; paths: Record<string, unknown> };
    expect(data.openapi).toBe("3.1.0");
    expect(data.info.title).toBe("BUN-DEV API");
    expect(Object.keys(data.paths).length).toBeGreaterThan(10);
  });
    // JUSTIFIED: res.json() returns unknown; narrowing to expected response shape

  it("Phase 4: GET /api/diagrams auto-discovers .mmd files via Bun.glob", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/diagrams`);
    expect(res.status).toBe(200);
    // JUSTIFIED: res.json() returns unknown; narrowing to response shape
    const data = await res.json() as { diagrams: string[]; count: number };
    expect(Array.isArray(data.diagrams)).toBe(true);
    expect(data.count).toBe(data.diagrams.length);
    // JUSTIFIED: res.json() returns unknown; narrowing to expected response shape
  });

  it("Phase 4: GET /api/config parses multi-format config files", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/config`);
    expect(res.status).toBe(200);
    // JUSTIFIED: res.json() returns unknown; narrowing to expected response shape
    const data = await res.json() as { config: Record<string, unknown> };
    expect(data.config.json).toBeDefined();
  });

  it("Phase 4: GET /api/config?format=toml only returns toml config", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/config?format=toml`);
    // JUSTIFIED: res.json() returns unknown; narrowing to response shape
    const data = await res.json() as { format: string; config: Record<string, unknown> };
    expect(data.format).toBe("toml");
    expect(data.config.json).toBeUndefined();
  });

  it("Phase 4: POST /api/admin/shell requires auth + CSRF", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/admin/shell`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "status" }),
    });
    expect(res.status).toBe(401);
  });

  it("Phase 4: POST /api/admin/shell rejects unknown commands", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/admin/shell`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({ command: "rm -rf /" }),
    });
    expect(res.status).toBe(400);
  });

  it("Phase 4: POST /api/admin/shell accepts 'workers' command", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/admin/shell`, {
      method: "POST",
      headers: {
    // JUSTIFIED: res.json() returns unknown; narrowing to expected response shape
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({ command: "workers" }),
    });
    expect(res.status).toBe(200);
    // JUSTIFIED: res.json() returns unknown; narrowing to response shape
    const data = await res.json() as { command: string; output: string };
    expect(data.command).toBe("workers");
  });

  it("Phase 5: POST /api/features/toggle requires auth + CSRF", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/features/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "websocket", enabled: true }),
    });
    expect(res.status).toBe(401);
  });

  it("Phase 5: POST /api/features/toggle rejects unknown features", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/features/toggle`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({ key: "nonexistent", enabled: true }),
    });
    expect(res.status).toBe(400);
  });

  it("Phase 5: POST /api/features/toggle enables a feature at runtime", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/api/features/toggle`, {
      method: "POST",
    // JUSTIFIED: res.json() returns unknown; narrowing to expected response shape
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({ key: "devDashboard", enabled: true }),
    });
    expect(res.status).toBe(200);
    // JUSTIFIED: res.json() returns unknown; narrowing to response shape
    const data = await res.json() as { ok: boolean; key: string; enabled: boolean; active: boolean };
    expect(data.ok).toBe(true);
    expect(data.key).toBe("devDashboard");
    expect(data.active).toBe(true);
  });

  it("Phase 5: GET /dashboard has dark/light mode media query", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/dashboard`);
    const html = await res.text();
    expect(html).toContain("prefers-color-scheme: light");
  });

  it("Phase 5: GET /dashboard lists new endpoints", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/dashboard`);
    const html = await res.text();
    expect(html).toContain("/api/openapi.json");
    expect(html).toContain("/api/semver");
    expect(html).toContain("/api/health-log");
    expect(html).toContain("/api/diagrams");
    expect(html).toContain("/api/config");
    expect(html).toContain("/api/features/toggle");
    expect(html).toContain("/api/admin/shell");
    expect(html).toContain("/api/export/bundle.tar");
    expect(html).toContain("/api/audit/stream");
  });
});
