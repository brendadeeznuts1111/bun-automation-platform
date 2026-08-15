/**
 * Typed environment variables for the Bun Automation Platform.
 *
 * Augments Bun's `Env` interface so `process.env.PORT` etc. are typed
 * as `string` instead of `string | undefined`. Every variable has a
 * runtime fallback in the consuming module, so these are all optional.
 *
 * Update this file when you add a new env var to the codebase.
 */

declare module "bun" {
  interface Env {
    // --- Server ---
    /** HTTP listen port. Default: "3000" */
    PORT?: string;
    /** HTTP listen host. Default: "0.0.0.0" */
    HOST?: string;
    /** Runtime environment. Default: "development" */
    NODE_ENV?: string;

    // --- Database ---
    /** SQLite database file path. Default: "./data/platform.db" */
    DB_PATH?: string;
    /** Number of read-only SQLite connections. Default: "4" */
    DB_READERS?: string;

    // --- Worker pool ---
    /** Number of pre-spawned worker processes. Default: "4" */
    WORKER_POOL_SIZE?: string;

    // --- Graceful shutdown ---
    /** Max milliseconds to wait for workers during shutdown. Default: "30000" */
    SHUTDOWN_TIMEOUT_MS?: string;

    // --- Screenshots (Bun.Image) ---
    /** Directory for processed screenshot files. Default: "./data/screenshots" */
    SCREENSHOT_DIR?: string;
    /** Thumbnail width in pixels. Default: "400" */
    THUMBNAIL_WIDTH?: string;
    /** Thumbnail WebP quality (1-100). Default: "85" */
    THUMBNAIL_QUALITY?: string;
    /** Full-size WebP quality (1-100). Default: "90" */
    SCREENSHOT_QUALITY?: string;

    // --- Circuit breaker ---
    /** Failures before circuit opens. Default: "5" */
    CIRCUIT_BREAKER_THRESHOLD?: string;
    /** Cooldown before half-open probe (ms). Default: "300000" (5 min) */
    CIRCUIT_BREAKER_COOLDOWN_MS?: string;

    // --- CORS ---
    /** Comma-separated allowed origins for production. In dev, only localhost is allowed (G1). */
    CORS_ALLOWED_ORIGINS?: string;

    // --- Security ---
    /** HMAC secret for CSRF token signing. Required in production. */
    CSRF_SECRET?: string;
    /** Trust X-Forwarded-For / CF-Connecting-IP headers. Default: "true" (set to "false" to disable) */
    TRUST_PROXY_HEADERS?: string;

    // --- WebView task execution ---
    /** Navigation timeout in ms. Default: "30000" */
    NAV_TIMEOUT?: string;
    /** WebView viewport width in pixels. Default: "1280" */
    VIEWPORT_WIDTH?: string;
    /** WebView viewport height in pixels. Default: "800" */
    VIEWPORT_HEIGHT?: string;
    /** Directory for persistent WebView profiles (cookies, localStorage). */
    PROFILE_DIR?: string;

    // --- TLS (dev-server.ts) ---
    /** Path to TLS certificate file. Default: "dev-cert.pem" */
    TLS_CERT_PATH?: string;
    /** Path to TLS private key file. Default: "dev-key.pem" */
    TLS_KEY_PATH?: string;

    // --- Mermaid renderer (render-mermaid.ts) ---
    /** Mermaid theme: "default" | "forest" | "dark" | "neutral". Default: "default" */
    MERMAID_THEME?: string;
    /** Output format: "svg" | "png". Default: "svg" (PDF not supported with Bun.WebView) */
    MERMAID_FORMAT?: string;
    /** Output directory for rendered files. Default: "." */
    MERMAID_OUTPUT_DIR?: string;
    /** Watchdog timeout for hung renders (ms). Default: "15000" */
    MERMAID_TIMEOUT_MS?: string;

    // --- Brand colors (render-mermaid.ts terminal output) ---
    /** Canvas background (CSS color, passed to mermaid-cli -b flag). */
    BRAND_COLOR_BG?: string;
    /** Terminal label color (CSS color). */
    BRAND_COLOR_LABEL?: string;
    /** Terminal value color (CSS color). */
    BRAND_COLOR_VALUE?: string;
    /** Terminal success color (CSS color). */
    BRAND_COLOR_OK?: string;
    /** Terminal error color (CSS color). */
    BRAND_COLOR_ERR?: string;
    /** Terminal warning color (CSS color). */
    BRAND_COLOR_WARN?: string;

    // --- Bun feature flags ---
    /** Enable experimental HTTP/2 fetch client. */
    BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT?: string;
  }
}
