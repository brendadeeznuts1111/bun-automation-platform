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
 * Usage:
 *   import { isFeatureEnabled, getFeatureStatus, listFeatures } from "./features/registry";
 *   if (isFeatureEnabled("http3")) { ... }
 */

export type FeatureStatus = "experimental" | "stable" | "promoted";

export interface FeatureFlag {
  /** Unique key for the feature. */
  key: string;
  /** Environment variable name (without the ENABLE_ prefix). */
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
    notes: "Placeholder dashboard — will be replaced with React + HTML imports dashboard (OPEN_TASKS F1).",
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
};

// --- Public API ------------------------------------------------------------

/**
 * Check if a feature is enabled via its environment variable.
 * Returns true if the env var is set to "1" or "true".
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
 * Get the feature flag metadata for a feature.
 */
export function getFeatureStatus(key: string): FeatureFlag | null {
  return FEATURES[key] ?? null;
}

/**
 * List all registered features with their current status.
 * Used by the /features endpoint.
 */
export function listFeatures(): FeatureFlag[] {
  return Object.values(FEATURES).map((f) => ({
    ...f,
    enabled: isFeatureEnabled(f.key),
  }));
}

/**
 * Check if all dependencies of a feature are enabled.
 * Returns true if the feature can be safely enabled.
 */
export function canEnable(key: string): boolean {
  const feature = FEATURES[key];
  if (!feature) return false;

  if (!isFeatureEnabled(key)) return false;

  for (const dep of feature.dependencies ?? []) {
    if (!isFeatureEnabled(dep)) {
      console.warn(`[features] ${key} requires ${dep} to be enabled`);
      return false;
    }
  }

  return true;
}

/**
 * Get a summary of feature flag status for logging at startup.
 */
export function getFeatureSummary(): string {
  const features = listFeatures();
  const enabled = features.filter((f) => (f as FeatureFlag & { enabled: boolean }).enabled); // JUSTIFIED: listFeatures() adds `enabled` boolean not in return type
  if (enabled.length === 0) return "none";
  return enabled.map((f) => `${f.key}(${f.status})`).join(", ");
}
