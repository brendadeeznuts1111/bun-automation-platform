/**
 * Enterprise validation for the Bun release ingest pipeline.
 *
 * Covers type guards, semantic rules, consistency, reporters, CLI parsing,
 * and validateAll against both fixtures and real release directories.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectIssues,
  escapeXml,
  extractHrefs,
  formatConsoleReport,
  generateJUnit,
  isCodeBlock,
  isExtractedData,
  isExtractedRelease,
  isNormalizedData,
  loadConfig,
  normalizeVersion,
  parseCliArgs,
  runCli,
  validateAll,
  validateConsistency,
  validateSemantics,
  validateVersionsParallel,
  type ExtractedRelease,
  type NormalizedBlock,
  type ValidationReport,
} from "../docs/releases/validate.ts";

const savedEnv = {
  STRICT_VALIDATION: process.env.STRICT_VALIDATION,
  MAX_WARNINGS: process.env.MAX_WARNINGS,
  MAX_ERRORS: process.env.MAX_ERRORS,
  VALID_STATUSES: process.env.VALID_STATUSES,
  VALID_LANGS: process.env.VALID_LANGS,
  COMPARE_VALIDATION_SNAPSHOT: process.env.COMPARE_VALIDATION_SNAPSHOT,
};

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function block(overrides: Partial<ExtractedRelease["code_blocks"][0]> = {}) {
  return {
    id: 1,
    feature: "Bun.Image",
    code: "await Bun.file('x').image()",
    purpose: "resize",
    status: "stable",
    notes: "ok",
    ...overrides,
  };
}

function extracted(overrides: Partial<ExtractedRelease> = {}): ExtractedRelease {
  return {
    release: "bun-v1.3.14",
    published: "2026-05-13",
    source: "https://bun.com/blog/bun-v1.3.14",
    code_blocks: [block()],
    ...overrides,
  };
}

function normalized(overrides: Partial<NormalizedBlock> = {}): NormalizedBlock {
  return {
    id: "bun-1.3.14-bun-image-1",
    feature: "Bun.Image",
    code: "await Bun.file('x').image()",
    purpose: "resize",
    status: "stable",
    notes: "ok",
    api: ["Bun.file"],
    dependencies: [],
    runnable: true,
    added_in: "1.3.14",
    ...overrides,
  };
}

async function writeFixture(
  data: { extracted: unknown; normalized: unknown },
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "validate-"));
  await Bun.write(`${dir}/extracted.json`, JSON.stringify(data.extracted, null, 2));
  await Bun.write(`${dir}/normalized.json`, JSON.stringify(data.normalized, null, 2));
  return dir;
}

describe("type guards", () => {
  it("accepts a valid code block", () => {
    expect(isCodeBlock({ lang: "ts", code: "const x = 1" })).toBe(true);
    expect(isCodeBlock({ lang: 1, code: "x" })).toBe(false);
  });

  it("accepts pipeline extracted + normalized shapes", () => {
    expect(isExtractedRelease(extracted())).toBe(true);
    expect(isNormalizedData([normalized()])).toBe(true);
    expect(isExtractedRelease({ sections: [] })).toBe(false);
  });

  it("accepts spec-style section extracted data", () => {
    const data = {
      sections: [{ heading: "HTTP", text: "hi", codeBlocks: [{ lang: "ts", code: "x" }] }],
    };
    expect(isExtractedData(data)).toBe(true);
    expect(isExtractedData({ sections: [{ heading: 1 }] })).toBe(false);
  });

  it("rejects malformed normalized arrays", () => {
    expect(isNormalizedData([{ heading: "x" }])).toBe(false);
    expect(isNormalizedData("nope")).toBe(false);
    expect(isNormalizedData([])).toBe(true);
  });
});

describe("semantic rules", () => {
  it("flags empty feature names as errors and empty code as warnings", () => {
    const src = extracted({
      code_blocks: [block({ feature: "  ", code: "   " })],
    });
    const issues = collectIssues(src, [normalized({ feature: "  " })], "1.3.14");
    expect(issues.some((i) => i.message.includes("empty feature") && i.severity === "error")).toBe(
      true,
    );
    expect(issues.some((i) => i.message.includes("empty code") && i.severity === "warning")).toBe(
      true,
    );
  });

  it("flags unknown languages as warnings only", () => {
    const src = extracted({
      code_blocks: [block({ lang: "cobol" })],
    });
    const issues = collectIssues(src, [normalized()], "1.3.14");
    const langs = issues.filter((i) => i.rule === "unknown-language");
    expect(langs).toHaveLength(1);
    expect(langs[0]?.severity).toBe("warning");
    expect(validateSemantics(src, [normalized()], "1.3.14")).not.toContainEqual(
      expect.stringContaining("cobol"),
    );
  });

  it("flags normalized features missing from extracted", () => {
    const errors = validateSemantics(extracted(), [normalized({ feature: "Ghost" })], "1.3.14");
    expect(errors.some((e) => e.includes("not found in extracted"))).toBe(true);
  });

  it("flags Stable + productionReady false", () => {
    const errors = validateSemantics(
      extracted(),
      [normalized({ productionReady: false })],
      "1.3.14",
    );
    expect(errors.some((e) => e.includes("Stable but productionReady false"))).toBe(true);
  });

  it("flags Highly Experimental + productionReady true", () => {
    const src = extracted({
      code_blocks: [block({ status: "Highly Experimental" })],
    });
    const errors = validateSemantics(
      src,
      [normalized({ status: "Highly Experimental", productionReady: true })],
      "1.3.14",
    );
    expect(errors.some((e) => e.includes("Highly Experimental but productionReady true"))).toBe(
      true,
    );
  });

  it("flags duplicate features", () => {
    const src = extracted({
      code_blocks: [block({ id: 1 }), block({ id: 2 })],
    });
    const errors = validateSemantics(src, [normalized(), normalized({ id: "other" })], "1.3.14");
    expect(errors.some((e) => e.includes("Duplicate feature"))).toBe(true);
  });

  it("flags extracted/normalized status mismatch", () => {
    const errors = validateSemantics(
      extracted(),
      [normalized({ status: "experimental" })],
      "1.3.14",
    );
    expect(errors.some((e) => e.includes("status 'experimental'"))).toBe(true);
  });

  it("validates spec-style section documents", () => {
    const src = {
      sections: [
        { heading: "", text: "x", codeBlocks: [{ lang: "cobol", code: "" }] },
        { heading: "HTTP", codeBlocks: [{ lang: "ts", code: "ok" }] },
        { heading: "HTTP", codeBlocks: [{ lang: "ts", code: "dup" }] },
      ],
      totalCodeBlocks: 1,
    };
    const norm = [
      {
        heading: "Missing",
        category: "net",
        status: "Stable",
        productionReady: false,
        codeBlocks: [{ lang: "ts", code: "x" }],
      },
    ];
    const issues = collectIssues(src, norm, "1.3.14");
    expect(issues.some((i) => i.message.includes("empty heading"))).toBe(true);
    expect(issues.some((i) => i.message.includes("empty code"))).toBe(true);
    expect(issues.some((i) => i.message.includes("unknown language"))).toBe(true);
    expect(issues.some((i) => i.message.includes("not found in extracted"))).toBe(true);
    expect(issues.some((i) => i.message.includes("Duplicate heading"))).toBe(true);
    expect(issues.some((i) => i.message.includes("Stable but productionReady false"))).toBe(true);
    expect(validateConsistency(src).some((e) => e.includes("Total code blocks"))).toBe(true);
  });

  it("flags added_in / release mismatches and duplicate ids", () => {
    const issues = collectIssues(
      extracted({ release: "bun-v9.9.9" }),
      [normalized({ added_in: "0.0.1" }), normalized({ id: "bun-1.3.14-bun-image-1", feature: "Other" })],
      "1.3.14",
    );
    expect(issues.some((i) => i.message.includes("added_in"))).toBe(true);
    expect(issues.some((i) => i.message.includes("extracted.release"))).toBe(true);
    expect(issues.some((i) => i.message.includes("Duplicate normalized id"))).toBe(true);
  });
});

describe("consistency", () => {
  it("checks totalCodeBlocks and assigned+missed", () => {
    const src = extracted({ totalCodeBlocks: 9, assignedCount: 1, missedCount: 1 });
    const errors = validateConsistency(src);
    expect(errors.some((e) => e.includes("Total code blocks mismatch"))).toBe(true);
    expect(errors.some((e) => e.includes("assignedCount"))).toBe(true);
  });

  it("passes when counts match", () => {
    expect(validateConsistency(extracted({ totalCodeBlocks: 1 }))).toEqual([]);
  });
});

describe("validateAll", () => {
  it("passes real bun-v1.3.14 and bun-v1.3.13 releases", async () => {
    const a = await validateAll("1.3.14");
    const b = await validateAll("bun-v1.3.13");
    expect(a.valid).toBe(true);
    expect(b.valid).toBe(true);
    expect(a.files.extracted.valid).toBe(true);
    expect(a.files.normalized.valid).toBe(true);
  });

  it("reports missing files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "validate-missing-"));
    try {
      const report = await validateAll("1.2.3", false, dir);
      expect(report.valid).toBe(false);
      expect(report.errors.some((e) => e.includes("extracted.json"))).toBe(true);
      expect(report.errors.some((e) => e.includes("normalized.json"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports invalid JSON and invalid shape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "validate-bad-"));
    try {
      await Bun.write(`${dir}/extracted.json`, "{not json");
      await Bun.write(`${dir}/normalized.json`, JSON.stringify({ nope: true }));
      const report = await validateAll("1.2.3", false, dir);
      expect(report.valid).toBe(false);
      expect(report.files.extracted.exists).toBe(true);
      expect(report.files.extracted.valid).toBe(false);
      expect(report.files.normalized.exists).toBe(true);
      expect(report.files.normalized.valid).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("surfaces semantic + consistency errors from fixtures", async () => {
    const dir = await writeFixture({
      extracted: extracted({
        totalCodeBlocks: 99,
        code_blocks: [block({ feature: "" })],
      }),
      normalized: [normalized({ feature: "" })],
    });
    try {
      const report = await validateAll("1.3.14", false, dir);
      expect(report.valid).toBe(false);
      expect(report.semanticErrors.length).toBeGreaterThan(0);
      expect(report.consistencyErrors.some((e) => e.includes("Total code blocks"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("strict mode fails on warnings", async () => {
    const dir = await writeFixture({
      extracted: extracted({ code_blocks: [block({ lang: "cobol" })] }),
      normalized: [normalized()],
    });
    try {
      const loose = await validateAll("1.3.14", false, dir);
      const strict = await validateAll("1.3.14", true, dir);
      expect(loose.warnings.length).toBeGreaterThan(0);
      expect(loose.valid).toBe(true);
      expect(strict.valid).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails when warnings exceed MAX_WARNINGS", async () => {
    process.env.MAX_WARNINGS = "0";
    const dir = await writeFixture({
      extracted: extracted({ code_blocks: [block({ lang: "cobol" })] }),
      normalized: [normalized()],
    });
    try {
      const report = await validateAll("1.3.14", false, dir);
      expect(report.valid).toBe(false);
      expect(report.errors.some((e) => e.includes("MAX_WARNINGS"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("reporters", () => {
  const failed: ValidationReport = {
    valid: false,
    schemaVersion: "1",
    errors: ["extracted.json has invalid shape.", "Section 0: empty heading"],
    warnings: ["unknown language 'cobol'"],
    errorsByCategory: {
      shape: ["extracted.json has invalid shape."],
      semantic: ["Section 0: empty heading"],
      consistency: [],
      regression: [],
    },
    files: {
      extracted: { exists: true, valid: false },
      normalized: { exists: true, valid: true },
    },
    semanticErrors: ["Section 0: empty heading"],
    consistencyErrors: [],
    regressionWarnings: [],
  };

  it("formats a console report", () => {
    const text = formatConsoleReport("1.3.14", failed);
    expect(text).toContain("FAIL");
    expect(text).toContain("empty heading");
    expect(text).toContain("cobol");
  });

  it("emits JUnit XML with escaped messages", () => {
    const xml = generateJUnit({
      ...failed,
      errors: ['bad <tag> & "quote"'],
      semanticErrors: ['bad <tag> & "quote"'],
      errorsByCategory: {
        ...failed.errorsByCategory,
        semantic: ['bad <tag> & "quote"'],
      },
    });
    expect(xml).toContain("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
    expect(xml).toContain("<failure");
    expect(xml).toContain('name="semantic"');
    expect(xml).toContain("&lt;tag&gt;");
    expect(xml).toContain("&amp;");
    expect(xml).not.toContain("<tag>");
  });

  it("escapeXml covers the five XML entities", () => {
    expect(escapeXml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });
});

describe("CLI", () => {
  it("parses positional version, --strict, and --report=", () => {
    const opts = parseCliArgs(["1.3.14", "--strict", "--report=json"]);
    expect(opts.version).toBe("1.3.14");
    expect(opts.strict).toBe(true);
    expect(opts.reportFormat).toBe("json");
  });

  it("parses --version and --report as separate flags", () => {
    const opts = parseCliArgs(["--version", "1.3.13", "--report", "junit"]);
    expect(opts.version).toBe("1.3.13");
    expect(opts.reportFormat).toBe("junit");
  });

  it("treats -V and bare --version as CLI version", () => {
    expect(parseCliArgs(["-V"]).showCliVersion).toBe(true);
    expect(parseCliArgs(["--cli-version"]).showCliVersion).toBe(true);
    expect(parseCliArgs(["--version"]).showCliVersion).toBe(true);
    expect(parseCliArgs(["--release", "1.3.14"]).version).toBe("1.3.14");
  });

  it("normalizeVersion strips bun-v", () => {
    expect(normalizeVersion("bun-v1.3.14")).toBe("1.3.14");
    expect(normalizeVersion("1.3.14")).toBe("1.3.14");
  });

  it("loadConfig reads env overrides", () => {
    process.env.STRICT_VALIDATION = "true";
    process.env.MAX_WARNINGS = "3";
    process.env.VALID_STATUSES = "stable,preview";
    const cfg = loadConfig();
    expect(cfg.strict).toBe(true);
    expect(cfg.maxWarnings).toBe(3);
    expect(cfg.validStatuses.has("preview")).toBe(true);
  });

  it("runCli exits 1 without a version", async () => {
    const logs: string[] = [];
    const code = await runCli([], {
      log: (s) => logs.push(s),
      error: (s) => logs.push(s),
    });
    expect(code).toBe(1);
    expect(logs.join("\n")).toContain("Usage:");
  });

  it("runCli prints JSON for a real release", async () => {
    const logs: string[] = [];
    const code = await runCli(["1.3.14", "--report", "json"], {
      log: (s) => logs.push(s),
      error: (s) => logs.push(s),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.valid).toBe(true);
  });

  it("runCli prints CLI version", async () => {
    const logs: string[] = [];
    const { CLI_VERSION } = await import("../packages/bun-validation/src/version.ts");
    const code = await runCli(["-V"], {
      log: (s) => logs.push(s),
      error: (s) => logs.push(s),
    });
    expect(code).toBe(0);
    expect(logs.join("")).toBe(CLI_VERSION);
  });

  it("runCli prints JUnit for a real release", async () => {
    const logs: string[] = [];
    const code = await runCli(["1.3.14", "--report=junit"], {
      log: (s) => logs.push(s),
      error: (s) => logs.push(s),
    });
    expect(code).toBe(0);
    expect(logs.join("")).toContain("<testsuite");
  });
});

describe("enhancements", () => {
  it("extracts and rejects invalid markdown / bare URLs", () => {
    expect(extractHrefs("See [docs](https://bun.com/docs) and https://bun.com")).toEqual([
      "https://bun.com/docs",
      "https://bun.com",
    ]);
    const src = extracted({
      code_blocks: [block({ notes: "See [x](http://%) and also #local" })],
    });
    const issues = collectIssues(src, [normalized()]);
    expect(issues.some((i) => i.rule === "markdown-links" && i.message.includes("http://%"))).toBe(
      true,
    );
  });

  it("schema v2 treats empty code as an error", () => {
    const src = extracted({
      schemaVersion: "2",
      code_blocks: [block({ code: "" })],
    });
    const errors = validateSemantics(src, [normalized({ code: "" })]);
    expect(errors.some((e) => e.includes("empty code"))).toBe(true);
  });

  it("groups JUnit failures by category", () => {
    const xml = generateJUnit({
      valid: false,
      schemaVersion: "1",
      errors: ["shape boom", "sem boom"],
      warnings: [],
      errorsByCategory: {
        shape: ["shape boom"],
        semantic: ["sem boom"],
        consistency: [],
        regression: [],
      },
      files: {
        extracted: { exists: true, valid: false },
        normalized: { exists: true, valid: true },
      },
      semanticErrors: ["sem boom"],
      consistencyErrors: [],
      regressionWarnings: [],
    });
    expect(xml).toContain('name="shape"');
    expect(xml).toContain('name="semantic"');
    expect(xml).toContain('name="consistency"');
    expect(xml).toContain('name="regression"');
    expect(xml).not.toContain("semantic_0");
  });

  it("validateVersionsParallel respects concurrency and baseDirFor", async () => {
    const dir = await writeFixture({
      extracted: extracted(),
      normalized: [normalized()],
    });
    try {
      const results = await validateVersionsParallel(["1.3.14"], {
        concurrency: 2,
        compareSnapshot: false,
        baseDirFor: () => dir,
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.report.valid).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("aborts the rule walk at MAX_ERRORS", () => {
    process.env.MAX_ERRORS = "1";
    const src = extracted({
      code_blocks: [block({ feature: "" }), block({ id: 2, feature: "" })],
    });
    const issues = collectIssues(src, [normalized({ feature: "" }), normalized({ id: "x", feature: "" })]);
    expect(issues.some((i) => i.rule === "max-errors")).toBe(true);
  });
});
