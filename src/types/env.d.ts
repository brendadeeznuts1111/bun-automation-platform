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
    /** Comma-separated allowed origins. Empty = allow all in dev. */
    CORS_ALLOWED_ORIGINS?: string;

    // --- Bun feature flags ---
    /** Enable experimental HTTP/2 fetch client. */
    BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT?: string;
  }
}
