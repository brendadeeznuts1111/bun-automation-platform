// Ref: https://bun.com/docs/runtime/file
// Ref: https://bun.com/docs/runtime/utils#import-meta

/** Default schema when artifacts omit `schemaVersion`. */
export const CURRENT_SCHEMA_VERSION = "1";
export const SUPPORTED_SCHEMA_VERSIONS = ["1", "2"] as const;
export type SchemaVersion = (typeof SUPPORTED_SCHEMA_VERSIONS)[number];

export interface CodeBlock {
  lang: string;
  code: string;
}

export interface ExtractedSection {
  heading: string;
  text?: string;
  codeBlocks: CodeBlock[];
}

export interface ExtractedData {
  schemaVersion?: string;
  version?: string;
  sections: ExtractedSection[];
  totalCodeBlocks?: number;
  assignedCount?: number;
  missedCount?: number;
}

export interface ExtractedBlock {
  id: number;
  feature: string;
  code: string;
  purpose: string;
  status: string;
  notes: string;
  lang?: string;
}

export interface ExtractedRelease {
  schemaVersion?: string;
  release: string;
  published?: string;
  source?: string;
  code_blocks: ExtractedBlock[];
  totalCodeBlocks?: number;
  assignedCount?: number;
  missedCount?: number;
}

export interface NormalizedFeature {
  schemaVersion?: string;
  heading: string;
  category: string;
  status: string;
  productionReady: boolean;
  apiSignature?: string;
  useCase?: string;
  codeBlocks: CodeBlock[];
  text?: string;
}

export interface NormalizedBlock {
  schemaVersion?: string;
  id: string;
  feature: string;
  code: string;
  purpose: string;
  status: string;
  notes: string;
  api: string[];
  dependencies: string[];
  runnable: boolean;
  added_in: string;
  productionReady?: boolean;
  lang?: string;
}

export type ReportFormat = "console" | "json" | "junit";
export type Severity = "error" | "warning";
export type ErrorCategory = "shape" | "semantic" | "consistency" | "regression";

export interface ValidationIssue {
  rule: string;
  message: string;
  severity: Severity;
  category?: ErrorCategory;
}

export interface ValidationReport {
  valid: boolean;
  schemaVersion: string;
  errors: string[];
  warnings: string[];
  errorsByCategory: Record<ErrorCategory, string[]>;
  files: {
    extracted: { exists: boolean; valid: boolean };
    normalized: { exists: boolean; valid: boolean };
  };
  semanticErrors: string[];
  consistencyErrors: string[];
  regressionWarnings: string[];
  regression?: RegressionDelta;
}

export interface ValidatorConfig {
  strict: boolean;
  maxWarnings: number;
  maxErrors: number;
  validStatuses: Set<string>;
  /** Exact casing variants preferred for status strings. */
  preferredStatusForms: Set<string>;
  validLangs: Set<string>;
  writeSnapshot: boolean;
  compareSnapshot: boolean;
}

export interface ValidateOptions {
  strict?: boolean;
  maxWarnings?: number;
  maxErrors?: number;
  /** Directory containing extracted.json + normalized.json */
  baseDir?: string;
  /** Directory for regression snapshots (reports/bun-vX.Y.Z.json) */
  reportsDir?: string;
  writeSnapshot?: boolean;
  compareSnapshot?: boolean;
  /** Per-version baseDir factory used by validateVersionsParallel. */
  baseDirFor?: (version: string) => string;
  concurrency?: number;
}

export interface CliOptions {
  version: string;
  reportFormat: ReportFormat;
  strict: boolean;
  help: boolean;
  showCliVersion: boolean;
  writeSnapshot: boolean;
  concurrency?: number;
}

export interface RuleContext {
  version: string;
  schemaVersion: SchemaVersion;
  extracted: ExtractedRelease | ExtractedData;
  normalized: NormalizedBlock[] | NormalizedFeature[];
  config: ValidatorConfig;
}

export interface RegressionDelta {
  newErrors: string[];
  resolvedErrors: string[];
  newWarnings: string[];
  resolvedWarnings: string[];
}

export interface Rule {
  id: string;
  description: string;
  run(ctx: RuleContext): ValidationIssue[];
}
