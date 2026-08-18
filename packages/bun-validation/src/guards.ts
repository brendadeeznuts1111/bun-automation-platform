import type {
  CodeBlock,
  ExtractedBlock,
  ExtractedData,
  ExtractedRelease,
  ExtractedSection,
  NormalizedBlock,
  NormalizedFeature,
} from "./types.ts";
import { CURRENT_SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS, type SchemaVersion } from "./types.ts";

export function isSchemaVersion(value: unknown): value is SchemaVersion {
  return value === "1" || value === "2";
}

export function readSchemaVersion(
  extracted: { schemaVersion?: string },
): SchemaVersion {
  return isSchemaVersion(extracted.schemaVersion)
    ? extracted.schemaVersion
    : CURRENT_SCHEMA_VERSION;
}

export function isRecord(obj: unknown): obj is Record<string, unknown> {
  return typeof obj === "object" && obj !== null;
}

export function isCodeBlock(obj: unknown): obj is CodeBlock {
  if (!isRecord(obj)) return false;
  return typeof obj.lang === "string" && typeof obj.code === "string";
}

export function isExtractedSection(obj: unknown): obj is ExtractedSection {
  if (!isRecord(obj)) return false;
  if (typeof obj.heading !== "string") return false;
  if (obj.text !== undefined && typeof obj.text !== "string") return false;
  if (!Array.isArray(obj.codeBlocks)) return false;
  return obj.codeBlocks.every(isCodeBlock);
}

function optionalString(obj: Record<string, unknown>, key: string): boolean {
  return obj[key] === undefined || typeof obj[key] === "string";
}

function optionalNumber(obj: Record<string, unknown>, key: string): boolean {
  return obj[key] === undefined || typeof obj[key] === "number";
}

export function isExtractedData(obj: unknown): obj is ExtractedData {
  if (!isRecord(obj)) return false;
  if (!Array.isArray(obj.sections)) return false;
  if (!optionalString(obj, "schemaVersion")) return false;
  if (!optionalString(obj, "version")) return false;
  if (!optionalNumber(obj, "totalCodeBlocks")) return false;
  if (!optionalNumber(obj, "assignedCount")) return false;
  if (!optionalNumber(obj, "missedCount")) return false;
  return obj.sections.every(isExtractedSection);
}

export function isExtractedBlock(obj: unknown): obj is ExtractedBlock {
  if (!isRecord(obj)) return false;
  return (
    typeof obj.id === "number" &&
    typeof obj.feature === "string" &&
    typeof obj.code === "string" &&
    typeof obj.purpose === "string" &&
    typeof obj.status === "string" &&
    typeof obj.notes === "string" &&
    (obj.lang === undefined || typeof obj.lang === "string")
  );
}

export function isExtractedRelease(obj: unknown): obj is ExtractedRelease {
  if (!isRecord(obj)) return false;
  if (typeof obj.release !== "string") return false;
  if (!Array.isArray(obj.code_blocks)) return false;
  if (!optionalString(obj, "schemaVersion")) return false;
  if (!optionalString(obj, "published")) return false;
  if (!optionalString(obj, "source")) return false;
  if (!optionalNumber(obj, "totalCodeBlocks")) return false;
  if (!optionalNumber(obj, "assignedCount")) return false;
  if (!optionalNumber(obj, "missedCount")) return false;
  return obj.code_blocks.every(isExtractedBlock);
}

export function isNormalizedFeature(obj: unknown): obj is NormalizedFeature {
  if (!isRecord(obj)) return false;
  return (
    typeof obj.heading === "string" &&
    typeof obj.category === "string" &&
    typeof obj.status === "string" &&
    typeof obj.productionReady === "boolean" &&
    (obj.schemaVersion === undefined || typeof obj.schemaVersion === "string") &&
    (obj.apiSignature === undefined || typeof obj.apiSignature === "string") &&
    (obj.useCase === undefined || typeof obj.useCase === "string") &&
    (obj.text === undefined || typeof obj.text === "string") &&
    Array.isArray(obj.codeBlocks) &&
    obj.codeBlocks.every(isCodeBlock)
  );
}

export function isNormalizedBlock(obj: unknown): obj is NormalizedBlock {
  if (!isRecord(obj)) return false;
  return (
    typeof obj.id === "string" &&
    typeof obj.feature === "string" &&
    typeof obj.code === "string" &&
    typeof obj.purpose === "string" &&
    typeof obj.status === "string" &&
    typeof obj.notes === "string" &&
    Array.isArray(obj.api) &&
    obj.api.every((v) => typeof v === "string") &&
    Array.isArray(obj.dependencies) &&
    obj.dependencies.every((v) => typeof v === "string") &&
    typeof obj.runnable === "boolean" &&
    typeof obj.added_in === "string" &&
    (obj.schemaVersion === undefined || typeof obj.schemaVersion === "string") &&
    (obj.productionReady === undefined || typeof obj.productionReady === "boolean") &&
    (obj.lang === undefined || typeof obj.lang === "string")
  );
}

export function isNormalizedData(obj: unknown): obj is NormalizedBlock[] | NormalizedFeature[] {
  if (!Array.isArray(obj)) return false;
  if (obj.length === 0) return true;
  const first = obj[0];
  if (isNormalizedBlock(first)) return obj.every(isNormalizedBlock);
  if (isNormalizedFeature(first)) return obj.every(isNormalizedFeature);
  return false;
}

export function explainExtracted(obj: unknown): string[] {
  if (!isRecord(obj)) return ["extracted.json is not an object"];
  if (Array.isArray(obj.sections)) {
    if (!isExtractedData(obj)) return ["extracted.json has invalid section shape"];
    return [];
  }
  if (Array.isArray(obj.code_blocks)) {
    if (!isExtractedRelease(obj)) return ["extracted.json has invalid code_blocks shape"];
    return [];
  }
  return ["extracted.json must have either sections[] or code_blocks[]"];
}

export function explainNormalized(obj: unknown): string[] {
  if (!Array.isArray(obj)) return ["normalized.json is not an array"];
  if (isNormalizedData(obj)) return [];
  return ["normalized.json has invalid item shape"];
}

export function isPipelineExtracted(obj: ExtractedRelease | ExtractedData): obj is ExtractedRelease {
  return "code_blocks" in obj;
}

export function isPipelineNormalized(
  obj: NormalizedBlock[] | NormalizedFeature[],
): obj is NormalizedBlock[] {
  const first = obj[0];
  return first !== undefined && "feature" in first && "added_in" in first;
}

export function schemaVersionIssues(
  extracted: ExtractedRelease | ExtractedData,
  normalized: NormalizedBlock[] | NormalizedFeature[],
): string[] {
  const errors: string[] = [];
  if (extracted.schemaVersion !== undefined && !isSchemaVersion(extracted.schemaVersion)) {
    errors.push(
      `extracted.schemaVersion '${extracted.schemaVersion}' is unsupported (supported: ${SUPPORTED_SCHEMA_VERSIONS.join(", ")})`,
    );
  }
  const expected = readSchemaVersion(extracted);
  for (let i = 0; i < normalized.length; i++) {
    const item = normalized[i];
    if (!item || item.schemaVersion === undefined) continue;
    if (!isSchemaVersion(item.schemaVersion)) {
      errors.push(
        `normalized[${i}].schemaVersion '${item.schemaVersion}' is unsupported (supported: ${SUPPORTED_SCHEMA_VERSIONS.join(", ")})`,
      );
      continue;
    }
    if (item.schemaVersion !== expected) {
      errors.push(
        `normalized[${i}].schemaVersion '${item.schemaVersion}' != extracted '${expected}'`,
      );
    }
  }
  return errors;
}
