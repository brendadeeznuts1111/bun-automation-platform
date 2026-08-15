/**
 * CORS middleware — configurable allowed origins.
 *
 * In development, allows localhost origins only. In production, restricts to
 * the configured allowed origins (comma-separated env var).
 *
 * G1: Previously, dev mode allowed ALL origins with credentials — a CORS
 * misconfiguration that could allow credential theft from any site. Now
 * dev mode only allows localhost/127.0.0.1 origins.
 */

const NODE_ENV = process.env.NODE_ENV ?? "development";
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Check if an origin is a localhost dev origin. */
function isLocalhostOrigin(origin: string): boolean {
  return (
    origin.startsWith("http://localhost") ||
    origin.startsWith("http://127.0.0.1") ||
    origin.startsWith("http://[::1]")
  );
}

/** Check if an origin is allowed. */
function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (NODE_ENV !== "production") {
    // G1: Dev mode — only allow localhost origins, not arbitrary sites
    return isLocalhostOrigin(origin);
  }
  if (ALLOWED_ORIGINS.length === 0) return false;
  return ALLOWED_ORIGINS.includes(origin);
}

/** CORS headers for a given request origin. */
export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");

  if (!isAllowedOrigin(origin)) {
    return {};
  }

  return {
    "Access-Control-Allow-Origin": origin!,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-CSRF-Token",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/** Handle CORS preflight (OPTIONS) requests. */
export function handlePreflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;

  const headers = corsHeaders(req);
  if (Object.keys(headers).length === 0) {
    return new Response("CORS not allowed", { status: 403 });
  }

  return new Response(null, { status: 204, headers });
}

/** Apply CORS headers to a response. */
export function withCors(req: Request, res: Response): Response {
  const headers = corsHeaders(req);
  if (Object.keys(headers).length === 0) return res;

  const newHeaders = new Headers(res.headers);
  for (const [k, v] of Object.entries(headers)) {
    newHeaders.set(k, v);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: newHeaders,
  });
}
