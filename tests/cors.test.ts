import { describe, expect, test } from "bun:test";
import { corsHeaders, handlePreflight, withCors } from "../src/middleware/cors";

describe("CORS Middleware", () => {
  test("generates CORS headers for request with localhost Origin", () => {
    // G1: Dev mode only allows localhost origins (not arbitrary sites)
    const req = new Request("http://localhost:3000/tasks", {
      headers: { origin: "http://localhost:5173" },
    });

    const headers = corsHeaders(req);
    expect(headers["Access-Control-Allow-Origin"]).toBe("http://localhost:5173");
    expect(headers["Access-Control-Allow-Methods"]).toContain("GET");
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
  });

  test("rejects non-localhost origins in dev mode (G1)", () => {
    const req = new Request("http://localhost:3000/tasks", {
      headers: { origin: "http://evil.com" },
    });

    const headers = corsHeaders(req);
    // G1: evil.com should NOT get CORS headers in dev mode
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  test("handles OPTIONS preflight requests for localhost origin", () => {
    const preflightReq = new Request("http://localhost:3000/task", {
      method: "OPTIONS",
      headers: { origin: "http://127.0.0.1:5173" },
    });

    const res = handlePreflight(preflightReq);
    expect(res).not.toBeNull();
    expect(res?.status).toBe(204);
    expect(res?.headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1:5173");
  });

  test("rejects OPTIONS preflight from non-localhost origins in dev mode (G1)", () => {
    const preflightReq = new Request("http://localhost:3000/task", {
      method: "OPTIONS",
      headers: { origin: "http://evil.com" },
    });

    const res = handlePreflight(preflightReq);
    expect(res).not.toBeNull();
    expect(res?.status).toBe(403);
  });

  test("applies CORS headers to outbound Response for localhost origin", () => {
    const req = new Request("http://localhost:3000/metrics", {
      headers: { origin: "http://localhost:8080" },
    });

    const originalRes = Response.json({ status: "ok" });
    const resWithCors = withCors(req, originalRes);

    expect(resWithCors.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:8080");
    expect(resWithCors.headers.get("Vary")).toBe("Origin");
  });
});
