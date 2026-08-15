import { describe, expect, it } from "bun:test";
import {
  isFeatureEnabled,
  getFeatureStatus,
  listFeatures,
  canEnable,
  getFeatureSummary,
} from "../src/features/registry";

// Helper to set/unset env vars for tests
function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    const original: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(vars)) {
      original[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      await fn();
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}

describe("Feature Flag Registry", () => {
  describe("isFeatureEnabled", () => {
    it("returns true when env var is '1'", withEnv({ ENABLE_TLS: "1" }, () => {
      expect(isFeatureEnabled("tls")).toBe(true);
    }));

    it("returns true when env var is 'true'", withEnv({ ENABLE_TLS: "true" }, () => {
      expect(isFeatureEnabled("tls")).toBe(true);
    }));

    it("returns false when env var is '0'", withEnv({ ENABLE_TLS: "0" }, () => {
      expect(isFeatureEnabled("tls")).toBe(false);
    }));

    it("returns false when env var is not set", withEnv({ ENABLE_TLS: undefined }, () => {
      expect(isFeatureEnabled("tls")).toBe(false);
    }));

    it("returns false for unknown feature", () => {
      expect(isFeatureEnabled("nonexistent")).toBe(false);
    });
  });

  describe("getFeatureStatus", () => {
    it("returns feature metadata for known feature", () => {
      const status = getFeatureStatus("http3");
      expect(status).not.toBeNull();
      expect(status?.key).toBe("http3");
      expect(status?.envVar).toBe("ENABLE_HTTP3");
      expect(status?.status).toBe("experimental");
      expect(status?.dependencies).toEqual(["tls"]);
    });

    it("returns null for unknown feature", () => {
      expect(getFeatureStatus("nonexistent")).toBeNull();
    });

    it("http3 is experimental and not ready for promotion", () => {
      const status = getFeatureStatus("http3");
      expect(status?.status).toBe("experimental");
      expect(status?.readyForPromotion).toBe(false);
    });

    it("tls is stable and ready for promotion", () => {
      const status = getFeatureStatus("tls");
      expect(status?.status).toBe("stable");
      expect(status?.readyForPromotion).toBe(true);
    });

    it("noOrphans is stable and ready for promotion", () => {
      const status = getFeatureStatus("noOrphans");
      expect(status?.status).toBe("stable");
      expect(status?.readyForPromotion).toBe(true);
    });
  });

  describe("listFeatures", () => {
    it("returns all registered features", () => {
      const features = listFeatures();
      expect(features.length).toBeGreaterThanOrEqual(6);
      const keys = features.map((f) => f.key);
      expect(keys).toContain("tls");
      expect(keys).toContain("http3");
      expect(keys).toContain("devDashboard");
      expect(keys).toContain("websocket");
      expect(keys).toContain("noOrphans");
      expect(keys).toContain("http3Client");
    });

    it("each feature has required fields", () => {
      const features = listFeatures();
      for (const f of features) {
        expect(f.key).toBeDefined();
        expect(f.envVar).toBeDefined();
        expect(f.status).toMatch(/^(experimental|stable|promoted)$/);
        expect(f.description).toBeDefined();
        expect(typeof f.readyForPromotion).toBe("boolean");
      }
    });
  });

  describe("canEnable", () => {
    it("returns false when feature env var is not set", withEnv({ ENABLE_HTTP3: undefined, ENABLE_TLS: undefined }, () => {
      expect(canEnable("http3")).toBe(false);
    }));

    it("returns false when feature is enabled but dependency is not", withEnv({ ENABLE_HTTP3: "1", ENABLE_TLS: undefined }, () => {
      expect(canEnable("http3")).toBe(false);
    }));

    it("returns true when feature and all dependencies are enabled", withEnv({ ENABLE_HTTP3: "1", ENABLE_TLS: "1" }, () => {
      expect(canEnable("http3")).toBe(true);
    }));

    it("returns true for tls with no dependencies", withEnv({ ENABLE_TLS: "1" }, () => {
      expect(canEnable("tls")).toBe(true);
    }));

    it("returns false for unknown feature", () => {
      expect(canEnable("nonexistent")).toBe(false);
    });
  });

  describe("getFeatureSummary", () => {
    it("returns 'none' when no features are enabled", withEnv({
      ENABLE_TLS: undefined,
      ENABLE_HTTP3: undefined,
      ENABLE_DEV_DASHBOARD: undefined,
      ENABLE_WEBSOCKET: undefined,
      BUN_FEATURE_FLAG_NO_ORPHANS: undefined,
      BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP3_CLIENT: undefined,
    }, () => {
      expect(getFeatureSummary()).toBe("none");
    }));

    it("returns comma-separated list when features are enabled", withEnv({
      ENABLE_TLS: "1",
      BUN_FEATURE_FLAG_NO_ORPHANS: "1",
    }, () => {
      const summary = getFeatureSummary();
      expect(summary).toContain("tls");
      expect(summary).toContain("noOrphans");
      expect(summary).toContain("(");
    }));
  });

  describe("Promotion status tracking", () => {
    it("experimental features are not ready for promotion", () => {
      const experimental = listFeatures().filter((f) => f.status === "experimental");
      for (const f of experimental) {
        // Experimental features should not be promoted until they pass tests
        // http3 is explicitly experimental per v1.3.14 blog
        if (f.key === "http3" || f.key === "http3Client" || f.key === "devDashboard" || f.key === "websocket") {
          expect(f.readyForPromotion).toBe(false);
        }
      }
    });

    it("stable features are ready for promotion", () => {
      const stable = listFeatures().filter((f) => f.status === "stable");
      for (const f of stable) {
        expect(f.readyForPromotion).toBe(true);
      }
    });
  });
});
