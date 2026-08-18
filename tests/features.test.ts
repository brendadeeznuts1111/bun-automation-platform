import { describe, expect, test } from "bun:test";
import {
  _reset,
  canEnable,
  getFeatureStatus,
  getFeatureSummary,
  isActive,
  isFeatureEnabled,
  listFeatures,
  markActive,
  markBlocked,
  shouldActivate,
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
    _reset(); // Clear runtime state before each test
    try {
      await fn();
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      _reset(); // Clear runtime state after each test
    }
  };
}

describe("Feature Flag Registry", () => {
  describe("isFeatureEnabled (env var check)", () => {
    test(
      "returns true when env var is '1'",
      withEnv({ ENABLE_TLS: "1" }, () => {
        expect(isFeatureEnabled("tls")).toBe(true);
      }),
    );

    test(
      "returns true when env var is 'true'",
      withEnv({ ENABLE_TLS: "true" }, () => {
        expect(isFeatureEnabled("tls")).toBe(true);
      }),
    );

    test(
      "returns false when env var is '0'",
      withEnv({ ENABLE_TLS: "0" }, () => {
        expect(isFeatureEnabled("tls")).toBe(false);
      }),
    );

    test(
      "returns false when env var is not set",
      withEnv({ ENABLE_TLS: undefined }, () => {
        expect(isFeatureEnabled("tls")).toBe(false);
      }),
    );

    test("isFeatureEnabled returns false for unknown feature", () => {
      expect(isFeatureEnabled("nonexistent")).toBe(false);
    });
  });

  describe("isActive (runtime state)", () => {
    test(
      "returns false before markActive is called",
      withEnv({ ENABLE_TLS: "1" }, () => {
        expect(isActive("tls")).toBe(false);
      }),
    );

    test(
      "returns true after markActive is called",
      withEnv({ ENABLE_TLS: "1" }, () => {
        markActive("tls");
        expect(isActive("tls")).toBe(true);
      }),
    );

    test("isActive returns false for unknown feature", () => {
      expect(isActive("nonexistent")).toBe(false);
    });
  });

  describe("markActive", () => {
    test("warns on unknown feature", () => {
      markActive("nonexistent");
      expect(isActive("nonexistent")).toBe(false);
    });
  });

  describe("markBlocked", () => {
    test(
      "records blocked reason",
      withEnv({ ENABLE_HTTP3: "1" }, () => {
        markBlocked("http3", "requires tls");
        const features = listFeatures();
        const http3 = features.find((f) => f.key === "http3");
        expect(http3?.blocked).toBe(true);
        expect(http3?.blockedReason).toBe("requires tls");
      }),
    );
  });

  describe("shouldActivate", () => {
    test(
      "returns false when env var is not set",
      withEnv({ ENABLE_HTTP3: undefined, ENABLE_TLS: undefined }, () => {
        expect(shouldActivate("http3")).toBe(false);
      }),
    );

    test(
      "returns false and marks blocked when dependency is missing",
      withEnv({ ENABLE_HTTP3: "1", ENABLE_TLS: undefined }, () => {
        expect(shouldActivate("http3")).toBe(false);
        const features = listFeatures();
        const http3 = features.find((f) => f.key === "http3");
        expect(http3?.blocked).toBe(true);
        expect(http3?.blockedReason).toContain("tls");
      }),
    );

    test(
      "returns true when feature and all dependencies are enabled",
      withEnv({ ENABLE_HTTP3: "1", ENABLE_TLS: "1" }, () => {
        expect(shouldActivate("http3")).toBe(true);
      }),
    );

    test(
      "returns true for tls with no dependencies",
      withEnv({ ENABLE_TLS: "1" }, () => {
        expect(shouldActivate("tls")).toBe(true);
      }),
    );

    test("shouldActivate returns false for unknown feature", () => {
      expect(shouldActivate("nonexistent")).toBe(false);
    });
  });

  describe("getFeatureStatus", () => {
    test("returns feature metadata for known feature", () => {
      const status = getFeatureStatus("http3");
      expect(status).not.toBeNull();
      expect(status?.key).toBe("http3");
      expect(status?.envVar).toBe("ENABLE_HTTP3");
      expect(status?.status).toBe("experimental");
      expect(status?.dependencies).toEqual(["tls"]);
    });

    test("returns null for unknown feature", () => {
      expect(getFeatureStatus("nonexistent")).toBeNull();
    });

    test("http3 is experimental and not ready for promotion", () => {
      const status = getFeatureStatus("http3");
      expect(status?.status).toBe("experimental");
      expect(status?.readyForPromotion).toBe(false);
    });

    test("tls is stable and ready for promotion", () => {
      const status = getFeatureStatus("tls");
      expect(status?.status).toBe("stable");
      expect(status?.readyForPromotion).toBe(true);
    });

    test("noOrphans is stable and ready for promotion", () => {
      const status = getFeatureStatus("noOrphans");
      expect(status?.status).toBe("stable");
      expect(status?.readyForPromotion).toBe(true);
    });
  });

  describe("listFeatures", () => {
    test("returns all registered features with state", () => {
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

    test("each feature has required fields including state", () => {
      const features = listFeatures();
      for (const f of features) {
        expect(f.key).toBeDefined();
        expect(f.envVar).toBeDefined();
        expect(f.status).toMatch(/^(experimental|stable|promoted)$/);
        expect(f.description).toBeDefined();
        expect(typeof f.readyForPromotion).toBe("boolean");
        expect(typeof f.requested).toBe("boolean");
        expect(typeof f.active).toBe("boolean");
        expect(typeof f.blocked).toBe("boolean");
      }
    });

    test(
      "requested=true when env var is set",
      withEnv({ ENABLE_TLS: "1" }, () => {
        const features = listFeatures();
        const tls = features.find((f) => f.key === "tls");
        expect(tls?.requested).toBe(true);
        expect(tls?.active).toBe(false); // not marked active yet
      }),
    );

    test(
      "active=true after markActive",
      withEnv({ ENABLE_TLS: "1" }, () => {
        markActive("tls");
        const features = listFeatures();
        const tls = features.find((f) => f.key === "tls");
        expect(tls?.active).toBe(true);
      }),
    );

    test(
      "blocked=true when requested but not active",
      withEnv({ ENABLE_TLS: "1" }, () => {
        const features = listFeatures();
        const tls = features.find((f) => f.key === "tls");
        expect(tls?.requested).toBe(true);
        expect(tls?.active).toBe(false);
        expect(tls?.blocked).toBe(true);
      }),
    );
  });

  describe("canEnable (dependency check only)", () => {
    test(
      "returns true when all dependencies are enabled",
      withEnv({ ENABLE_TLS: "1" }, () => {
        expect(canEnable("http3")).toBe(true); // tls dep is satisfied
      }),
    );

    test(
      "returns false when dependency is missing",
      withEnv({ ENABLE_TLS: undefined }, () => {
        expect(canEnable("http3")).toBe(false);
      }),
    );

    test("returns true for feature with no dependencies", () => {
      expect(canEnable("tls")).toBe(true);
    });

    test("canEnable returns false for unknown feature", () => {
      expect(canEnable("nonexistent")).toBe(false);
    });
  });

  describe("getFeatureSummary (active features only)", () => {
    test(
      "returns 'none' when no features are active",
      withEnv(
        {
          ENABLE_TLS: undefined,
          ENABLE_HTTP3: undefined,
        },
        () => {
          expect(getFeatureSummary()).toBe("none");
        },
      ),
    );

    test(
      "returns 'none' when features are requested but not active",
      withEnv(
        {
          ENABLE_TLS: "1",
        },
        () => {
          // requested but markActive not called
          expect(getFeatureSummary()).toBe("none");
        },
      ),
    );

    test(
      "returns active features only",
      withEnv(
        {
          ENABLE_TLS: "1",
        },
        () => {
          markActive("tls");
          const summary = getFeatureSummary();
          expect(summary).toContain("tls");
          expect(summary).toContain("(stable)");
        },
      ),
    );

    test(
      "shows multiple active features",
      withEnv(
        {
          ENABLE_TLS: "1",
          ENABLE_HTTP3: "1",
        },
        () => {
          markActive("tls");
          markActive("http3");
          const summary = getFeatureSummary();
          expect(summary).toContain("tls");
          expect(summary).toContain("http3");
        },
      ),
    );
  });

  describe("Promotion status tracking", () => {
    test("experimental features are not ready for promotion", () => {
      const experimental = listFeatures().filter((f) => f.status === "experimental");
      for (const f of experimental) {
        if (f.key === "http3" || f.key === "http3Client" || f.key === "devDashboard" || f.key === "websocket") {
          expect(f.readyForPromotion).toBe(false);
        }
      }
    });

    test("stable features are ready for promotion", () => {
      const stable = listFeatures().filter((f) => f.status === "stable");
      for (const f of stable) {
        expect(f.readyForPromotion).toBe(true);
      }
    });
  });

  describe("Three-state tracking (requested/active/blocked)", () => {
    test(
      "feature can be requested but not active (not yet enabled)",
      withEnv({ ENABLE_TLS: "1" }, () => {
        const features = listFeatures();
        const tls = features.find((f) => f.key === "tls");
        expect(tls?.requested).toBe(true);
        expect(tls?.active).toBe(false);
        expect(tls?.blocked).toBe(true);
      }),
    );

    test(
      "feature can be requested and active (fully running)",
      withEnv({ ENABLE_TLS: "1" }, () => {
        markActive("tls");
        const features = listFeatures();
        const tls = features.find((f) => f.key === "tls");
        expect(tls?.requested).toBe(true);
        expect(tls?.active).toBe(true);
        expect(tls?.blocked).toBe(false);
      }),
    );

    test(
      "feature can be requested and blocked (dep missing)",
      withEnv({ ENABLE_HTTP3: "1", ENABLE_TLS: undefined }, () => {
        shouldActivate("http3"); // This marks it blocked
        const features = listFeatures();
        const http3 = features.find((f) => f.key === "http3");
        expect(http3?.requested).toBe(true);
        expect(http3?.active).toBe(false);
        expect(http3?.blocked).toBe(true);
        expect(http3?.blockedReason).toContain("tls");
      }),
    );

    test(
      "feature can be off (not requested, not active, not blocked)",
      withEnv({ ENABLE_TLS: undefined }, () => {
        const features = listFeatures();
        const tls = features.find((f) => f.key === "tls");
        expect(tls?.requested).toBe(false);
        expect(tls?.active).toBe(false);
        expect(tls?.blocked).toBe(false);
      }),
    );
  });
});
