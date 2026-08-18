import type { ReportFormat, ValidationReport } from "./types.ts";
import { normalizeVersion } from "./engine.ts";

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function generateJUnit(report: ValidationReport, version = ""): string {
  const cats = report.errorsByCategory ?? {
    shape: [],
    semantic: report.semanticErrors ?? [],
    consistency: report.consistencyErrors ?? [],
    regression: report.regressionWarnings ?? [],
  };
  const names = ["shape", "semantic", "consistency", "regression"] as const;
  const failed = names.filter((name) => cats[name].length > 0);
  const suiteName = version
    ? `Validation bun-v${normalizeVersion(version)}`
    : "Validation";
  const failures = report.valid ? 0 : Math.max(failed.length, report.errors.length > 0 ? 1 : 0);

  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites>`,
    `  <testsuite name="${escapeXml(suiteName)}" tests="${names.length}" failures="${failures}" errors="0">`,
  ];
  for (const name of names) {
    lines.push(`    <testcase name="${name}" classname="Validation">`);
    const bucket = cats[name];
    if (bucket.length > 0) {
      lines.push(
        `      <failure message="${escapeXml(bucket[0] ?? name)}">${escapeXml(bucket.join("; "))}</failure>`,
      );
    } else if (!report.valid && name === "shape" && failed.length === 0) {
      lines.push(
        `      <failure message="${escapeXml(report.errors.join("; ") || "Validation failed")}"/>`,
      );
    }
    lines.push(`    </testcase>`);
  }
  lines.push(`  </testsuite>`, `</testsuites>`);
  return lines.join("\n");
}

export function formatConsoleReport(version: string, report: ValidationReport): string {
  const lines = [
    "",
    `📋 VALIDATION REPORT for version ${normalizeVersion(version)}`,
    "=====================================",
    `Status: ${report.valid ? "✅ PASS" : "❌ FAIL"}`,
    `Schema: ${report.schemaVersion}`,
  ];
  if (report.errors.length) {
    lines.push("", "Errors:");
    for (const e of report.errors) lines.push(`  ❌ ${e}`);
  }
  if (report.warnings.length) {
    lines.push("", "Warnings:");
    for (const w of report.warnings) lines.push(`  ⚠️ ${w}`);
  }
  const cats = report.errorsByCategory;
  if (cats.shape.length || cats.semantic.length || cats.consistency.length || cats.regression.length) {
    lines.push("", "By category:");
    if (cats.shape.length) lines.push(`  shape: ${cats.shape.length}`);
    if (cats.semantic.length) lines.push(`  semantic: ${cats.semantic.length}`);
    if (cats.consistency.length) lines.push(`  consistency: ${cats.consistency.length}`);
    if (cats.regression.length) lines.push(`  regression: ${cats.regression.length}`);
  }
  lines.push(
    "",
    "Files:",
    `  extracted.json: ${report.files.extracted.exists ? "exists" : "missing"}, ${report.files.extracted.valid ? "valid" : "invalid"}`,
    `  normalized.json: ${report.files.normalized.exists ? "exists" : "missing"}, ${report.files.normalized.valid ? "valid" : "invalid"}`,
  );
  return lines.join("\n");
}

export function renderReport(
  report: ValidationReport,
  version: string,
  format: ReportFormat,
): string {
  switch (format) {
    case "json":
      return JSON.stringify(report, null, 2);
    case "junit":
      return generateJUnit(report, version);
    default:
      return formatConsoleReport(version, report);
  }
}
