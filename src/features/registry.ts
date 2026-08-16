/**
 * Feature Flag Registry
 *
 * Tracks all gated features with their promotion status:
 *   - "experimental" — behind a flag, not ready for production
 *   - "stable" — tested and verified, safe to enable in production
 *   - "promoted" — enabled by default, flag is a no-op (kept for compat)
 *
 * Each feature has:
 *   - envVar: the environment variable that enables it (value "1" or "true")
 *   - status: current promotion status
 *   - description: what the feature does
 *   - dependencies: other features that must also be enabled
 *   - readyForPromotion: true when all tests pass and the feature is
 *     considered safe to enable by default in the next release
 *
 * Three states are tracked per feature:
 *   - requested: env var is set to "1" or "true" (user asked for it)
 *   - active: feature is actually running (server.ts called markActive())
 *   - blocked: requested but can't run (missing dependency, missing cert, etc.)
 *
 * Usage:
 *   import { isFeatureEnabled, canEnable, markActive, listFeatures } from "./features/registry";
 *   if (canEnable("http3")) { ... markActive("http3"); }
 */

export type FeatureStatus = "experimental" | "stable" | "promoted";

export interface FeatureFlag {
  /** Unique key for the feature. */
  key: string;
  /** Environment variable name. */
  envVar: string;
  /** Current promotion status. */
  status: FeatureStatus;
  /** Human-readable description. */
  description: string;
  /** Other feature keys that must also be enabled for this to work. */
  dependencies?: string[];
  /** True when the feature has passed all tests and is ready to be
   *  enabled by default in the next release. When true and status is
   *  "stable", the next release should set status to "promoted". */
  readyForPromotion: boolean;
  /** Additional notes about the feature (limitations, ref links). */
  notes?: string;
}

export interface FeatureFlagWithState extends FeatureFlag {
  /** True if the env var is set to "1" or "true" (user requested it). */
  requested: boolean;
  /** True if the feature is actually running at runtime. */
  active: boolean;
  /** True if requested but blocked (missing dependency or other issue). */
  blocked: boolean;
  /** Human-readable reason if blocked. */
  blockedReason?: string;
}

// --- Feature definitions ---------------------------------------------------

const FEATURES: Record<string, FeatureFlag> = {
  tls: {
    key: "tls",
    envVar: "ENABLE_TLS",
    status: "stable",
    description: "Enable TLS (HTTPS) for the main server. Requires TLS_CERT_PATH + TLS_KEY_PATH.",
    dependencies: [],
    readyForPromotion: true,
    notes: "Stable — TLS is a standard Bun.serve feature. Set ENABLE_TLS=1 with cert/key paths.",
  },

  http3: {
    key: "http3",
    envVar: "ENABLE_HTTP3",
    status: "experimental",
    description: "Enable HTTP/3 (QUIC) over UDP on the same port alongside HTTP/1.1. Browsers auto-upgrade via Alt-Svc.",
    dependencies: ["tls"],
    readyForPromotion: false,
    notes: "Experimental per v1.3.14 blog: 'Do not deploy http3: true to production yet.' WebSocket over HTTP/3 not supported. 0-RTT disabled. Ref: https://bun.sh/blog/bun-v1.3.14#http-3-quic-support-in-bun-serve",
  },

  devDashboard: {
    key: "devDashboard",
    envVar: "ENABLE_DEV_DASHBOARD",
    status: "experimental",
    description: "Serve a dev dashboard at /dashboard showing server status, feature flags, and protocol info.",
    dependencies: [],
    readyForPromotion: false,
    notes: "Auto-enabled in development mode. Will be replaced with React + HTML imports dashboard (OPEN_TASKS F1).",
  },

  websocket: {
    key: "websocket",
    envVar: "ENABLE_WEBSOCKET",
    status: "experimental",
    description: "Enable WebSocket endpoints for live task progress streaming and remote browser control.",
    dependencies: [],
    readyForPromotion: false,
    notes: "WebSocket endpoints /ws/task/:id and /ws/control/:id. Not yet implemented (OPEN_TASKS C1, C2). WebSocket over HTTP/3 is not supported in v1.3.14.",
  },

  noOrphans: {
    key: "noOrphans",
    envVar: "BUN_FEATURE_FLAG_NO_ORPHANS",
    status: "stable",
    description: "Exit automatically when parent process dies. Set on worker subprocesses in pool.ts.",
    dependencies: [],
    readyForPromotion: true,
    notes: "Enabled by default on all worker subprocesses. Ref: https://bun.sh/blog/bun-v1.3.14#no-orphans-exit-when-the-parent-process-dies",
  },

  http3Client: {
    key: "http3Client",
    envVar: "BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP3_CLIENT",
    status: "experimental",
    description: "Enable experimental HTTP/3 fetch client. Used by render-mermaid.ts for URL fetches.",
    dependencies: [],
    readyForPromotion: false,
    notes: "Experimental per v1.3.14 blog. render-mermaid.ts uses protocol: 'http3' with fallback to HTTP/1.1.",
  },

  sitemap: {
    key: "sitemap",
    envVar: "ENABLE_SITEMAP",
    status: "experimental",
    description: "Serve /sitemap.xml with a generated list of public static routes.",
    dependencies: [],
    readyForPromotion: false,
    notes: "Bun.XML.stringify will replace the manual XML builder after the project upgrades to Bun v1.4.",
  },

  htmlRewriter: {
    key: "htmlRewriter",
    envVar: "ENABLE_HTML_REWRITER",
    status: "experimental",
    description: "Use HTMLRewriter to dynamically inject theme-color meta, feature flags script, and nonce attributes into HTML responses.",
    dependencies: [],
    readyForPromotion: false,
    notes: "HTMLRewriter is a built-in Bun API (like Cloudflare's). Ref: https://bun.com/docs/runtime/htmlrewriter",
  },
};

// --- Runtime state ---------------------------------------------------------
// Tracks which features are actually running (set by server.ts via markActive).
const activeFeatures = new Set<string>();

// Tracks why a requested feature couldn't be activated.
const blockedFeatures = new Map<string, string>();

// --- Public API ------------------------------------------------------------

/**
 * Check if a feature is requested via its environment variable.
 * Returns true if the env var is set to "1" or "true".
 * Note: "requested" does not mean "active" — use isActive() or canEnable().
 */
export function isFeatureEnabled(key: string): boolean {
  const feature = FEATURES[key];
  if (!feature) {
    console.warn(`[features] unknown feature: ${key}`);
    return false;
  }

  const value = process.env[feature.envVar];
  return value === "1" || value === "true";
}

/**
 * Check if a feature is actually running at runtime.
 * Returns true if markActive(key) was called.
 */
export function isActive(key: string): boolean {
  return activeFeatures.has(key);
}

/**
 * Mark a feature as actively running.
 * Called by server.ts after successfully enabling a feature.
 */
export function markActive(key: string): void {
  if (!FEATURES[key]) {
    console.warn(`[features] cannot mark unknown feature as active: ${key}`);
    return;
  }
  activeFeatures.add(key);
}

/**
 * Mark a feature as blocked (requested but can't run).
 * Called by server.ts when a feature can't be enabled.
 */
export function markBlocked(key: string, reason: string): void {
  blockedFeatures.set(key, reason);
}

/**
 * Get the feature flag metadata for a feature.
 */
export function getFeatureStatus(key: string): FeatureFlag | null {
  return FEATURES[key] ?? null;
}

/**
 * List all registered features with their runtime state.
 * Used by the /features endpoint.
 */
export function listFeatures(): FeatureFlagWithState[] {
  return Object.values(FEATURES).map((f) => {
    const requested = isFeatureEnabled(f.key);
    const active = activeFeatures.has(f.key);
    const blockedReason = blockedFeatures.get(f.key);
    return {
      ...f,
      requested,
      active,
      blocked: requested && !active,
      blockedReason,
    };
  });
}

/**
 * Check if all dependencies of a feature are enabled.
 * Returns true if the feature can be safely enabled.
 * Does NOT check if the feature itself is requested — use isFeatureEnabled() first.
 */
export function canEnable(key: string): boolean {
  const feature = FEATURES[key];
  if (!feature) return false;

  for (const dep of feature.dependencies ?? []) {
    if (!isFeatureEnabled(dep)) {
      return false;
    }
  }

  return true;
}

/**
 * Check if a feature is requested and all dependencies are satisfied.
 * If dependencies are missing, marks the feature as blocked with a reason.
 * Returns true if the feature should be activated.
 */
export function shouldActivate(key: string): boolean {
  const feature = FEATURES[key];
  if (!feature) return false;

  if (!isFeatureEnabled(key)) return false;

  const missingDeps = (feature.dependencies ?? []).filter((dep) => !isFeatureEnabled(dep));
  if (missingDeps.length > 0) {
    markBlocked(key, `requires ${missingDeps.join(", ")} to be enabled`);
    return false;
  }

  return true;
}

/**
 * Get a summary of actively running features for logging at startup.
 * Only shows features that are actually active (not just requested).
 */
export function getFeatureSummary(): string {
  const active = listFeatures().filter((f) => f.active);
  if (active.length === 0) return "none";
  return active.map((f) => `${f.key}(${f.status})`).join(", ");
}

/**
 * Reset runtime state (for tests).
 */
export function _reset(): void {
  activeFeatures.clear();
  blockedFeatures.clear();
}
