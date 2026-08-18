import { expect, test } from "bun:test";
import { httpFetch, httpFetchJson, isHttp2ClientEnabled } from "../src/utils/http-client";

test("isHttp2ClientEnabled reflects env var", () => {
  // Just check it returns a boolean — env state is process-wide
  expect(typeof isHttp2ClientEnabled()).toBe("boolean");
});

test("httpFetch fetches a URL and returns a Response", async () => {
  // Use a simple HTTP endpoint — Bun's own server in test mode
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("hello", { headers: { "Content-Type": "text/plain" } }),
  });
  try {
    const res = await httpFetch(server.url.toString());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("hello");
  } finally {
    server.stop();
  }
});

test("httpFetch sends custom headers", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (req) => new Response(req.headers.get("x-custom") ?? "missing"),
  });
  try {
    const res = await httpFetch(server.url.toString(), {
      headers: { "x-custom": "test-value" },
    });
    expect(await res.text()).toBe("test-value");
  } finally {
    server.stop();
  }
});

test("httpFetchJson parses JSON response", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ status: "ok", count: 42 }),
  });
  try {
    const data = await httpFetchJson<{ status: string; count: number }>(server.url.toString());
    expect(data.status).toBe("ok");
    expect(data.count).toBe(42);
  } finally {
    server.stop();
  }
});

test("httpFetchJson throws on non-2xx", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response("not found", { status: 404 }),
  });
  try {
    await expect(httpFetchJson(server.url.toString())).rejects.toThrow("HTTP 404");
  } finally {
    server.stop();
  }
});

test("httpFetch respects timeout", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async () => {
      await Bun.sleep(2000);
      return new Response("slow");
    },
  });
  try {
    await expect(httpFetch(server.url.toString(), { timeoutMs: 100, maxRetries: 1 })).rejects.toThrow();
  } finally {
    server.stop();
  }
});

test("httpFetch retries on 5xx responses", async () => {
  let attempts = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      attempts++;
      if (attempts < 3) return new Response("error", { status: 500 });
      return new Response("ok", { status: 200 });
    },
  });
  try {
    const res = await httpFetch(server.url.toString(), { maxRetries: 3, retryBaseDelayMs: 10 });
    expect(res.status).toBe(200);
    expect(attempts).toBe(3);
    expect(await res.text()).toBe("ok");
  } finally {
    server.stop();
  }
});

test("httpFetch buffers ReadableStream body for retry replay", async () => {
  let attempts = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      attempts++;
      const text = await req.text();
      if (attempts < 2) return new Response("error", { status: 500 });
      return new Response(`echo: ${text}`, { status: 200 });
    },
  });
  try {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("stream-body-data"));
        controller.close();
      },
    });
    const res = await httpFetch(server.url.toString(), {
      method: "POST",
      body: stream,
      maxRetries: 3,
      retryBaseDelayMs: 10,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("echo: stream-body-data");
    expect(attempts).toBe(2);
  } finally {
    server.stop();
  }
});
