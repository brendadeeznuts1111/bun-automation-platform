import {
  type ValidatorConfig,
  CURRENT_SCHEMA_VERSION,
} from "./types.ts";

/** Load KEY=VALUE pairs from `.env.validation` without clobbering existing env. */
export async function loadValidationEnv(
  path = `${process.cwd()}/.env.validation`,
): Promise<void> {
  const file = Bun.file(path);
  if (!(await file.exists())) return;
  const text = await file.text();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const DEFAULT_STATUSES = [
  "stable",
  "experimental",
  "highly experimental",
  "unknown",
] as const;

/** Preferred exact spellings (lowercase for pipeline; Title Case for document). */
const PREFERRED_STATUS_FORMS = [
  "stable",
  "experimental",
  "highly experimental",
  "unknown",
  "Stable",
  "Experimental",
  "Highly Experimental",
  "Unknown",
] as const;

const DEFAULT_LANGS = [
  "ts",
  "js",
  "json",
  "sh",
  "bash",
  "text",
  "html",
  "css",
  "md",
  "toml",
  "env",
] as const;

function parseNonNegInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): ValidatorConfig {
  const statusSource = env.VALID_STATUSES?.trim()
    ? env.VALID_STATUSES.split(",")
    : DEFAULT_STATUSES;
  const langSource = env.VALID_LANGS?.trim() ? env.VALID_LANGS.split(",") : DEFAULT_LANGS;
  const preferred = env.PREFERRED_STATUSES?.trim()
    ? env.PREFERRED_STATUSES.split(",")
    : PREFERRED_STATUS_FORMS;

  return {
    strict: env.STRICT_VALIDATION === "true",
    maxWarnings: parseNonNegInt(env.MAX_WARNINGS, 10),
    maxErrors: parseNonNegInt(env.MAX_ERRORS, 50),
    validStatuses: new Set(statusSource.map((s) => s.trim().toLowerCase()).filter(Boolean)),
    preferredStatusForms: new Set(preferred.map((s) => s.trim()).filter(Boolean)),
    validLangs: new Set(langSource.map((s) => s.trim().toLowerCase()).filter(Boolean)),
    writeSnapshot: env.WRITE_VALIDATION_SNAPSHOT === "true",
    compareSnapshot: env.COMPARE_VALIDATION_SNAPSHOT !== "false",
  };
}

export { CURRENT_SCHEMA_VERSION };
