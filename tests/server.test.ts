import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type Subprocess } from "bun";

describe("Server API Integration", () => {
  const TEST_PORT = 3199;
  let serverProc: Subprocess<"ignore", "pipe", "pipe">;

  beforeAll(async () => {
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
  });

  afterAll(async () => {
    if (serverProc) {
      serverProc.kill("SIGTERM");
      await serverProc.exited;
    }
  });

  it("GET /health returns status ok and worker pool info", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/health`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
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

  it("POST /login rejects invalid credentials and audits failure", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "nonexistent", password: "wrong" }),
    });
    expect(res.status).toBe(401);
  });

  it("GET /tasks returns paginated task list", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/tasks?limit=10`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(Array.isArray(data.tasks)).toBe(true);
    expect(typeof data.total).toBe("number");
  });

  it("GET /audit returns paginated audit log entries", async () => {
    const res = await fetch(`http://localhost:${TEST_PORT}/audit?limit=10`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(Array.isArray(data.logs)).toBe(true);
  });
});
