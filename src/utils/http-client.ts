/**
 * HTTP/2-enabled fetch client for outbound requests.
 *
 * Bun v1.3.14 introduced experimental HTTP/2 client support for fetch().
 * When enabled via BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT=1, fetch()
 * automatically negotiates HTTP/2 with multiplexing and connection coalescing.
 *
 * This utility wraps fetch() with:
 * - HTTP/2 negotiation (via env flag)
 * - Retry with exponential backoff (via withRetry)
 * - Timeout support (via AbortSignal)
 * - User-Agent identification
 *
 * Ref: bun-v1.3.14 blog — Experimental HTTP/2 Client for fetch()
 * Ref: node_modules/bun-types/docs/runtime/http/fetch.mdx
 */

import { withRetry } from "./retry";

/** Default timeout for outbound HTTP requests (30s). */
const DEFAULT_TIMEOUT_MS = parseInt(process.env.HTTP_CLIENT_TIMEOUT_MS ?? "30000", 10);

/** User agent for outbound requests — identifies the platform. */
const USER_AGENT = `BUN-DEV/${Bun.version} (automation-platform)`;

/**
 * Fetch options for the HTTP client.
 */
export interface HttpFetchOptions {
  /** Request method (default: GET). */
  method?: string;
  /** Request headers. */
  headers?: Record<string, string>;
  /** Request body (for POST/PUT). */
  body?: BodyInit | null;
  /** Timeout in milliseconds (default: 30000). */
  timeoutMs?: number;
  /** Max retry attempts on 5xx or network errors (default: 3). */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms (default: 1000). */
  retryBaseDelayMs?: number;
  /** Retry on 5xx responses (default: true). When false, only network errors retry. */
  retryOn5xx?: boolean;
}

/**
 * Fetch a URL with HTTP/2 support, retry, and timeout.
 *
 * HTTP/2 is automatically negotiated when BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT=1
 * is set in the environment. Without the flag, falls back to HTTP/1.1.
 *
 * @example
 * ```ts
 * const res = await httpFetch("https://api.example.com/data");
 * const data = await res.json();
 * ```
 */
export async function httpFetch(url: string, options: HttpFetchOptions = {}): Promise<Response> {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = 3,
    retryBaseDelayMs = 1000,
    retryOn5xx = true,
  } = options;

  // Buffer stream bodies before the retry loop — ReadableStream can only be
  // consumed once, so retry attempts would get an empty/errored stream.
  // For non-stream bodies (string, ArrayBuffer, Blob, null), pass through.
  // JUSTIFIED: BodyInit includes ReadableStream which is single-use; buffering
  // to ArrayBuffer makes it replayable across retry attempts.
  let replayableBody: BodyInit | null | undefined = body;
  if (body instanceof ReadableStream) {
    const buffered = await new Response(body).arrayBuffer();
    replayableBody = buffered;
  }

  // Each retry attempt gets its own AbortController + timeout. If we shared a
  // single controller across retries, the first timeout would abort all
  // subsequent attempts instantly — defeating the retry logic.
  //
  // For 5xx responses: fetch() doesn't throw on 5xx — it returns a Response
  // with ok: false. We check the status and throw to trigger a retry, so
  // withRetry's retryable() callback can decide whether to retry.
  return await withRetry(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method,
          headers: { "User-Agent": USER_AGENT, ...headers },
          body: replayableBody,
          signal: controller.signal,
        });
        // Throw on 5xx so withRetry can retry — fetch doesn't throw on HTTP errors
        if (retryOn5xx && res.status >= 500 && res.status < 600) {
          throw new HttpError(`HTTP ${res.status}`, res.status);
        }
        return res;
      } finally {
        clearTimeout(timeout);
      }
    },
    {
      maxAttempts: maxRetries,
      baseDelayMs: retryBaseDelayMs,
      // Don't retry on abort (timeout) — that's intentional
      retryable: (err) => {
        if (err instanceof DOMException && err.name === "AbortError") return false;
        if (err instanceof HttpError && err.status >= 500 && err.status < 600) return true;
        return true; // retry on network errors — withRetry handles the count
      },
    },
  );
}

/** Internal error class for HTTP status codes (used for 5xx retry logic). */
class HttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/**
 * Fetch JSON from a URL with HTTP/2 support.
 * Parses the response as JSON and returns the parsed value.
 *
 * @example
 * ```ts
 * const data = await httpFetchJson<{ status: string }>("https://api.example.com/health");
 * ```
 */
export async function httpFetchJson<T>(url: string, options: HttpFetchOptions = {}): Promise<T> {
  const res = await httpFetch(url, { ...options, headers: { Accept: "application/json", ...options.headers } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText} for ${url}`);
  }
  // JUSTIFIED: res.json() returns unknown; narrowing to T per caller's expectation
  return (await res.json()) as T;
}

/**
 * Check if HTTP/2 client is enabled in the current environment.
 * Returns true when BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT=1 is set.
 */
export function isHttp2ClientEnabled(): boolean {
  return process.env.BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT === "1";
}
