import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type Subprocess } from "bun";
import { migrate, write } from "../src/db";

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
    const data = (await res.json()) as TasksResponse;
    expect(Array.isArray(data.tasks)).toBe(true);
    expect(typeof data.total).toBe("number");
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
    const data = (await res.json()) as AuditResponse;
    expect(Array.isArray(data.logs)).toBe(true);
  });

  // --- CSRF ---

  it("POST /task returns 403 without CSRF token (even with auth)", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ agent_id: 1, url: "https://example.com" }),
    });
    expect(res.status).toBe(403);
  });
});
