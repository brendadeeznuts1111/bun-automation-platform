/**
 * Unit tests for bun-validation (guards, semantics, consistency, CLI, JUnit).
 *
 * Ref: https://bun.com/docs/test/writing-tests
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_SCHEMA_VERSION,
  collectIssues,
  escapeXml,
  generateJUnit,
  isCodeBlock,
  isExtractedRelease,
  isNormalizedBlock,
  loadConfig,
  parseCliArgs,
  validateAll,
  validateConsistency,
  validateSemantics,
} from "../packages/bun-validation/src/index.ts";

const fixtureRoot = mkdtempSync(join(tmpdir(), "bun-validation-"));

function pipelineExtracted(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    release: "bun-v1.0.0",
    code_blocks: [
      {
        id: 1,
        feature: "Bun.serve",
        code: "Bun.serve({ fetch() { return new Response('ok'); } })",
        purpose: "HTTP server",
        status: "stable",
        notes: "example",
      },
    ],
    ...overrides,
  };
}

function pipelineNormalized(overrides: Record<string, unknown>[] = [{}]) {
  return overrides.map((o, i) => ({
    id: `bun-1.0.0-bun-serve-${i + 1}`,
    feature: "Bun.serve",
    code: "Bun.serve({ fetch() { return new Response('ok'); } })",
    purpose: "HTTP server",
    status: "stable",
    notes: "example",
    api: ["Bun.serve"],
    dependencies: [],
    runnable: true,
    added_in: "1.0.0",
    ...o,
  }));
}

beforeAll(async () => {
  const dir = join(fixtureRoot, "bun-v1.0.0");
  await Bun.write(`${dir}/extracted.json`, JSON.stringify(pipelineExtracted(), null, 2));
  await Bun.write(`${dir}/normalized.json`, JSON.stringify(pipelineNormalized(), null, 2));
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("guards", () => {
  it("accepts a valid code block", () => {
    expect(isCodeBlock({ lang: "ts", code: "1" })).toBe(true);
    expect(isCodeBlock({ lang: 1, code: "1" })).toBe(false);
  });

  it("accepts pipeline extracted + normalized shapes", () => {
    expect(isExtractedRelease(pipelineExtracted())).toBe(true);
    expect(isNormalizedBlock(pipelineNormalized()[0])).toBe(true);
  });
});

describe("semantics", () => {
  it("flags empty feature as error", () => {
    const extracted = pipelineExtracted({
      code_blocks: [
        {
          id: 1,
          feature: "   ",
          code: "x",
          purpose: "p",
          status: "stable",
          notes: "n",
        },
      ],
    });
    const errors = validateSemantics(extracted, pipelineNormalized([{ feature: "   " }]), "1.0.0");
    expect(errors.some((e) => e.includes("empty feature"))).toBe(true);
  });

  it("warns on pipeline empty code instead of erroring", () => {
    const extracted = pipelineExtracted({
      code_blocks: [
        {
          id: 1,
          feature: "Faster runtime",
          code: "",
          purpose: "memory",
          status: "stable",
          notes: "AUTOMATIC — no code change",
        },
      ],
    });
    const normalized = pipelineNormalized([
      { feature: "Faster runtime", code: "", notes: "AUTOMATIC — no code change" },
    ]);
    const config = loadConfig();
    const issues = collectIssues(extracted, normalized, "1.0.0", config);
    const empty = issues.filter((i) => i.rule === "empty-code");
    expect(empty.length).toBe(1);
    expect(empty[0]?.severity).toBe("warning");
  });
});

describe("consistency", () => {
  it("detects totalCodeBlocks mismatch", () => {
    const extracted = pipelineExtracted({ totalCodeBlocks: 99 });
    const errors = validateConsistency(extracted);
    expect(errors[0]).toContain("Total code blocks mismatch");
  });
});

describe("CLI parse", () => {
  it("parses --version, --strict, --report, --cli-version", () => {
    const opts = parseCliArgs([
      "--version",
      "1.3.14",
      "--strict",
      "--report=json",
      "--cli-version",
    ]);
    expect(opts.version).toBe("1.3.14");
    expect(opts.strict).toBe(true);
    expect(opts.reportFormat).toBe("json");
    expect(opts.showCliVersion).toBe(true);
  });
});

describe("JUnit + grouping", () => {
  it("escapes XML and emits failures", () => {
    expect(escapeXml(`a<b>&"c'`)).toBe("a&lt;b&gt;&amp;&quot;c&apos;");
    const xml = generateJUnit({
      valid: false,
      schemaVersion: "1",
      errors: ["shape bad", "sem bad"],
      warnings: [],
      errorsByCategory: {
        shape: ["shape bad"],
        semantic: ["sem bad"],
        consistency: [],
        regression: [],
      },
      files: {
        extracted: { exists: true, valid: false },
        normalized: { exists: true, valid: true },
      },
      semanticErrors: ["sem bad"],
      consistencyErrors: [],
      regressionWarnings: [],
    });
    expect(xml).toContain("<failure");
    expect(xml).toContain("semantic_0");
  });
});

describe("validateAll against temp fixtures", () => {
  it("passes a valid release dir", async () => {
    const report = await validateAll("1.0.0", {
      baseDir: join(fixtureRoot, "bun-v1.0.0"),
      reportsDir: join(fixtureRoot, "reports"),
      compareSnapshot: false,
    });
    expect(report.valid).toBe(true);
    expect(report.files.extracted.valid).toBe(true);
    expect(report.errorsByCategory.semantic).toEqual([]);
  });

  it("fails when extracted is missing", async () => {
    const report = await validateAll("9.9.9", {
      baseDir: join(fixtureRoot, "missing"),
      reportsDir: join(fixtureRoot, "reports"),
      compareSnapshot: false,
    });
    expect(report.valid).toBe(false);
    expect(report.errorsByCategory.shape.length).toBeGreaterThan(0);
  });
});
