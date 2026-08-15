import { describe, expect, it } from "bun:test";
import { corsHeaders, handlePreflight, withCors } from "../src/middleware/cors";

describe("CORS Middleware", () => {
  it("generates CORS headers for request with Origin", () => {
    const req = new Request("http://localhost:3000/tasks", {
      headers: { origin: "http://example.com" },
    });

    const headers = corsHeaders(req);
    expect(headers["Access-Control-Allow-Origin"]).toBe("http://example.com");
    expect(headers["Access-Control-Allow-Methods"]).toContain("GET");
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
  });

  it("handles OPTIONS preflight requests", () => {
    const preflightReq = new Request("http://localhost:3000/task", {
      method: "OPTIONS",
      headers: { origin: "http://dashboard.local" },
    });

    const res = handlePreflight(preflightReq);
    expect(res).not.toBeNull();
    expect(res?.status).toBe(204);
    expect(res?.headers.get("Access-Control-Allow-Origin")).toBe("http://dashboard.local");
  });

  it("applies CORS headers to outbound Response", () => {
    const req = new Request("http://localhost:3000/metrics", {
      headers: { origin: "http://metrics.local" },
    });

    const originalRes = Response.json({ status: "ok" });
    const resWithCors = withCors(req, originalRes);

    expect(resWithCors.headers.get("Access-Control-Allow-Origin")).toBe("http://metrics.local");
    expect(resWithCors.headers.get("Vary")).toBe("Origin");
  });
});
