import { loadConfig, CURRENT_SCHEMA_VERSION } from "./config.ts";
import {
  explainExtracted,
  explainNormalized,
  isExtractedData,
  isExtractedRelease,
  isNormalizedData,
  isPipelineExtracted,
  schemaVersionIssues,
} from "./guards.ts";
import { collectIssues } from "./rules.ts";
import type {
  ErrorCategory,
  ExtractedData,
  ExtractedRelease,
  NormalizedBlock,
  NormalizedFeature,
  ValidateOptions,
  ValidationReport,
} from "./types.ts";

export function normalizeVersion(version: string): string {
  return version.replace(/^bun-v/i, "");
}

export function validateConsistency(extracted: ExtractedRelease | ExtractedData): string[] {
  const errors: string[] = [];
  const actual = isPipelineExtracted(extracted)
    ? extracted.code_blocks.length
    : extracted.sections.reduce((acc, s) => acc + s.codeBlocks.length, 0);

  if (extracted.totalCodeBlocks !== undefined && actual !== extracted.totalCodeBlocks) {
    errors.push(
      `Total code blocks mismatch: declared ${extracted.totalCodeBlocks}, actual ${actual}`,
    );
  }
  if (
    extracted.assignedCount !== undefined &&
    extracted.missedCount !== undefined &&
    extracted.assignedCount + extracted.missedCount !== actual
  ) {
    errors.push(
      `assignedCount (${extracted.assignedCount}) + missedCount (${extracted.missedCount}) != actual ${actual}`,
    );
  }
  return errors;
}

export function validateNormalizedCount(
  extracted: ExtractedRelease | ExtractedData,
  normalized: NormalizedBlock[] | NormalizedFeature[],
): string[] {
  const expected = isPipelineExtracted(extracted)
    ? extracted.code_blocks.length
    : extracted.sections.length;
  if (normalized.length !== expected) {
    return [`Normalized count mismatch: extracted ${expected}, normalized ${normalized.length}`];
  }
  return [];
}

function emptyCategories(): Record<ErrorCategory, string[]> {
  return { shape: [], semantic: [], consistency: [], regression: [] };
}

function emptyReport(): ValidationReport {
  return {
    valid: true,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    errors: [],
    warnings: [],
    errorsByCategory: emptyCategories(),
    files: {
      extracted: { exists: false, valid: false },
      normalized: { exists: false, valid: false },
    },
    semanticErrors: [],
    consistencyErrors: [],
    regressionWarnings: [],
  };
}

async function readJson(
  path: string,
): Promise<{ exists: boolean; value: unknown; error?: string }> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { exists: false, value: null, error: `${path} missing or unparseable.` };
  }
  try {
    return { exists: true, value: await file.json() };
  } catch {
    return { exists: true, value: null, error: `${path} missing or unparseable.` };
  }
}

export function snapshotPath(reportsDir: string, version: string): string {
  return `${reportsDir}/bun-v${normalizeVersion(version)}.json`;
}

export async function compareRegressionSnapshot(
  report: ValidationReport,
  reportsDir: string,
  version: string,
): Promise<{ messages: string[]; delta?: import("./types.ts").RegressionDelta }> {
  const path = snapshotPath(reportsDir, version);
  const file = Bun.file(path);
  if (!(await file.exists())) return { messages: [] };
  try {
    const prev = await file.json();
    if (!isRecord(prev) || !Array.isArray(prev.errors)) return { messages: [] };
    const prevErrors = new Set(prev.errors.filter((e): e is string => typeof e === "string"));
    const prevWarnings = new Set(
      Array.isArray(prev.warnings)
        ? prev.warnings.filter((e): e is string => typeof e === "string")
        : [],
    );
    const delta = {
      newErrors: report.errors.filter((e) => !prevErrors.has(e)),
      resolvedErrors: [...prevErrors].filter((e) => !report.errors.includes(e)),
      newWarnings: report.warnings.filter((w) => !prevWarnings.has(w)),
      resolvedWarnings: [...prevWarnings].filter((w) => !report.warnings.includes(w)),
    };
    const messages = [
      ...delta.newErrors.map((e) => `New error vs snapshot: ${e}`),
      ...delta.newWarnings.map((w) => `New warning vs snapshot: ${w}`),
    ];
    return { messages, delta };
  } catch {
    return { messages: [`Could not parse regression snapshot at ${path}`] };
  }
}

function isRecord(obj: unknown): obj is Record<string, unknown> {
  return typeof obj === "object" && obj !== null;
}

export async function writeRegressionSnapshot(
  report: ValidationReport,
  reportsDir: string,
  version: string,
): Promise<string> {
  const path = snapshotPath(reportsDir, version);
  const payload = {
    version: normalizeVersion(version),
    schemaVersion: report.schemaVersion,
    valid: report.valid,
    errors: report.errors,
    warnings: report.warnings,
    errorsByCategory: report.errorsByCategory,
    generatedAt: new Date().toISOString(),
  };
  await Bun.write(path, JSON.stringify(payload, null, 2));
  return path;
}

function applyThresholds(
  report: ValidationReport,
  strict: boolean,
  maxWarnings: number,
  maxErrors: number,
): void {
  if (report.warnings.length > maxWarnings) {
    const msg = `Warning count ${report.warnings.length} exceeds MAX_WARNINGS=${maxWarnings}`;
    report.errors.push(msg);
    report.errorsByCategory.shape.push(msg);
  }
  if (maxErrors > 0 && report.errors.length > maxErrors) {
    const msg = `Error count ${report.errors.length} exceeds MAX_ERRORS=${maxErrors}`;
    report.errors.push(msg);
    report.errorsByCategory.shape.push(msg);
  }
  report.valid = report.errors.length === 0;
  if (strict && report.warnings.length > 0) {
    report.valid = false;
  }
}

/**
 * Validate extracted.json + normalized.json for a release version.
 * @param version Release version like "1.3.14" or "bun-v1.3.14"
 * @param optionsOrStrict boolean strict flag or full options bag
 */
export async function validateAll(
  version: string,
  optionsOrStrict: boolean | ValidateOptions = {},
  baseDirArg?: string,
): Promise<ValidationReport> {
  const options: ValidateOptions =
    typeof optionsOrStrict === "boolean" ? { strict: optionsOrStrict } : optionsOrStrict;
  if (baseDirArg) options.baseDir = baseDirArg;
  const config = loadConfig();
  const strict = options.strict ?? config.strict;
  const maxWarnings = options.maxWarnings ?? config.maxWarnings;
  const maxErrors = options.maxErrors ?? config.maxErrors;
  const writeSnapshot = options.writeSnapshot ?? config.writeSnapshot;
  const compareSnapshot = options.compareSnapshot ?? config.compareSnapshot;

  const versionNum = normalizeVersion(version);
  const baseDir = options.baseDir ?? `${process.cwd()}/docs/releases/bun-v${versionNum}`;
  const reportsDir = options.reportsDir ?? `${process.cwd()}/docs/releases/reports`;
  const report = emptyReport();

  const extractedRead = await readJson(`${baseDir}/extracted.json`);
  let extractedData: ExtractedRelease | ExtractedData | null = null;
  if (!extractedRead.exists) {
    report.errors.push("extracted.json missing or unparseable.");
    report.errorsByCategory.shape.push("extracted.json missing or unparseable.");
  } else if (extractedRead.error) {
    report.files.extracted.exists = true;
    report.errors.push("extracted.json missing or unparseable.");
    report.errorsByCategory.shape.push("extracted.json missing or unparseable.");
  } else {
    report.files.extracted.exists = true;
    const shapeErrors = explainExtracted(extractedRead.value);
    if (
      shapeErrors.length === 0 &&
      (isExtractedRelease(extractedRead.value) || isExtractedData(extractedRead.value))
    ) {
      report.files.extracted.valid = true;
      extractedData = extractedRead.value;
    } else {
      report.errors.push("extracted.json has invalid shape.");
      report.errorsByCategory.shape.push("extracted.json has invalid shape.");
      for (const e of shapeErrors) {
        report.errors.push(e);
        report.errorsByCategory.shape.push(e);
      }
    }
  }

  const normalizedRead = await readJson(`${baseDir}/normalized.json`);
  let normalizedData: NormalizedBlock[] | NormalizedFeature[] | null = null;
  if (!normalizedRead.exists) {
    report.errors.push("normalized.json missing or unparseable.");
    report.errorsByCategory.shape.push("normalized.json missing or unparseable.");
  } else if (normalizedRead.error) {
    report.files.normalized.exists = true;
    report.errors.push("normalized.json missing or unparseable.");
    report.errorsByCategory.shape.push("normalized.json missing or unparseable.");
  } else {
    report.files.normalized.exists = true;
    const shapeErrors = explainNormalized(normalizedRead.value);
    if (shapeErrors.length === 0 && isNormalizedData(normalizedRead.value)) {
      report.files.normalized.valid = true;
      normalizedData = normalizedRead.value;
    } else {
      report.errors.push("normalized.json has invalid shape.");
      report.errorsByCategory.shape.push("normalized.json has invalid shape.");
      for (const e of shapeErrors) {
        report.errors.push(e);
        report.errorsByCategory.shape.push(e);
      }
    }
  }

  if (
    extractedData &&
    normalizedData &&
    report.files.extracted.valid &&
    report.files.normalized.valid
  ) {
    for (const e of schemaVersionIssues(extractedData, normalizedData)) {
      report.errors.push(e);
      report.errorsByCategory.shape.push(e);
    }

    const issues = collectIssues(extractedData, normalizedData, versionNum, config);
    report.semanticErrors = issues.filter((i) => i.severity === "error").map((i) => i.message);
    report.warnings.push(...issues.filter((i) => i.severity === "warning").map((i) => i.message));
    for (const e of report.semanticErrors) {
      report.errors.push(e);
      report.errorsByCategory.semantic.push(e);
    }

    const consErrors = [
      ...validateConsistency(extractedData),
      ...validateNormalizedCount(extractedData, normalizedData),
    ];
    report.consistencyErrors = consErrors;
    for (const e of consErrors) {
      report.errors.push(e);
      report.errorsByCategory.consistency.push(e);
    }
  }

  if (compareSnapshot) {
    const regression = await compareRegressionSnapshot(report, reportsDir, versionNum);
    report.regressionWarnings = regression.messages;
    report.regression = regression.delta;
    report.warnings.push(...regression.messages);
    for (const e of regression.messages) {
      report.errorsByCategory.regression.push(e);
    }
  }

  applyThresholds(report, strict, maxWarnings, maxErrors);

  if (writeSnapshot) {
    await writeRegressionSnapshot(report, reportsDir, versionNum);
  }

  return report;
}

/** Run validateAll over many versions with limited concurrency. */
export async function validateVersionsParallel(
  versions: string[],
  options: ValidateOptions = {},
): Promise<{ version: string; report: ValidationReport }[]> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const results: { version: string; report: ValidationReport }[] = [];
  for (let i = 0; i < versions.length; i += concurrency) {
    const batch = versions.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (version) => {
        const baseDir = options.baseDirFor?.(version) ?? options.baseDir;
        return {
          version,
          report: await validateAll(version, { ...options, baseDir }),
        };
      }),
    );
    results.push(...batchResults);
  }
  return results;
}
