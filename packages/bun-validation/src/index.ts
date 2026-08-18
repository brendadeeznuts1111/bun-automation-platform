// bun-validation — zero-dependency Bun-native release artifact validator
// Ref: https://bun.com/docs/runtime/file

export {
  CURRENT_SCHEMA_VERSION,
  loadConfig,
  loadValidationEnv,
} from "./config.ts";
export {
  explainExtracted,
  explainNormalized,
  isCodeBlock,
  isExtractedBlock,
  isExtractedData,
  isExtractedRelease,
  isExtractedSection,
  isNormalizedBlock,
  isNormalizedData,
  isNormalizedFeature,
  isPipelineExtracted,
  isPipelineNormalized,
  isRecord,
  isSchemaVersion,
  readSchemaVersion,
  schemaVersionIssues,
} from "./guards.ts";
export {
  RULES,
  collectIssues,
  extractHrefs,
  resolveSchemaVersion,
  validateSemantics,
  validateSemanticWarnings,
} from "./rules.ts";
export {
  compareRegressionSnapshot,
  normalizeVersion,
  snapshotPath,
  validateAll,
  validateConsistency,
  validateNormalizedCount,
  validateVersionsParallel,
  writeRegressionSnapshot,
} from "./engine.ts";
export {
  escapeXml,
  formatConsoleReport,
  generateJUnit,
  renderReport,
} from "./reporters.ts";
export {
  USAGE,
  isReportFormat,
  parseCliArgs,
  runCli,
} from "./cli.ts";
export { CLI_VERSION } from "./version.ts";
export type {
  CliOptions,
  CodeBlock,
  ErrorCategory,
  ExtractedBlock,
  ExtractedData,
  ExtractedRelease,
  ExtractedSection,
  NormalizedBlock,
  NormalizedFeature,
  ReportFormat,
  RegressionDelta,
  Rule,
  RuleContext,
  SchemaVersion,
  Severity,
  ValidateOptions,
  ValidationIssue,
  ValidationReport,
  ValidatorConfig,
} from "./types.ts";
export { SUPPORTED_SCHEMA_VERSIONS } from "./types.ts";
