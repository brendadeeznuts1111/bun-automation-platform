import { loadValidationEnv } from "./config.ts";
import { CLI_VERSION } from "./version.ts";
import { renderReport } from "./report.ts";
import { validateAll } from "./validate.ts";
import type { CliOptions, ReportFormat } from "./types.ts";

export function isReportFormat(value: string): value is ReportFormat {
  return value === "console" || value === "json" || value === "junit";
}

export const USAGE = `Usage: bun-validate <version> [options]

Validate extracted.json + normalized.json for a Bun release.

Arguments:
  <version>              Release version (e.g. 1.3.14 or bun-v1.3.14)

Options:
  --release <ver>        Same as positional version (release under test)
  --version <ver>        Same as --release when a value is given
  -V, --cli-version      Print bun-validation package version and exit
  --strict               Treat warnings as failures
  --report <fmt>         console | json | junit (default: console)
  --write-snapshot       Write docs/releases/reports/bun-vX.Y.Z.json
  --concurrency <n>      Parallel workers for validate-all (default: 4)
  -h, --help             Show this help

Env (.env.validation is loaded if present; existing env wins):
  STRICT_VALIDATION=true
  MAX_WARNINGS=10
  MAX_ERRORS=50            (0 = unlimited)
  VALIDATE_CONCURRENCY=4
  WRITE_VALIDATION_SNAPSHOT=true
  COMPARE_VALIDATION_SNAPSHOT=false
`;

export function parseCliArgs(args: string[]): CliOptions {
  let version = "";
  let reportFormat: ReportFormat = "console";
  let strict = false;
  let help = false;
  let showCliVersion = false;
  let writeSnapshot = false;
  let concurrency: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--cli-version" || arg === "-V") {
      showCliVersion = true;
      continue;
    }
    if (arg === "--strict") {
      strict = true;
      continue;
    }
    if (arg === "--write-snapshot") {
      writeSnapshot = true;
      continue;
    }
    if (arg === "--version" || arg.startsWith("--version=") || arg === "--release" || arg.startsWith("--release=")) {
      const flag = arg.startsWith("--release") ? "--release=" : "--version=";
      const value = arg.includes("=") ? arg.slice(flag.length) : args[++i];
      if (value && !value.startsWith("-")) version = value;
      else showCliVersion = true;
      continue;
    }
    if (arg === "--concurrency" || arg.startsWith("--concurrency=")) {
      const value = arg.includes("=") ? arg.slice("--concurrency=".length) : args[++i];
      const n = value ? Number.parseInt(value, 10) : Number.NaN;
      if (Number.isFinite(n) && n > 0) concurrency = n;
      continue;
    }
    if (arg === "--report" || arg.startsWith("--report=")) {
      const value = arg.includes("=") ? arg.slice("--report=".length) : args[++i];
      if (value && isReportFormat(value)) reportFormat = value;
      continue;
    }
    if (!version && !arg.startsWith("-")) {
      version = arg;
    }
  }

  return { version, reportFormat, strict, help, showCliVersion, writeSnapshot, concurrency };
}

export async function runCli(
  args: string[],
  io: { log: (s: string) => void; error: (s: string) => void } = console,
  defaults: { baseDir?: (version: string) => string; reportsDir?: string } = {},
): Promise<number> {
  await loadValidationEnv();
  const opts = parseCliArgs(args);
  if (opts.showCliVersion) {
    io.log(CLI_VERSION);
    return 0;
  }
  if (opts.help) {
    io.log(USAGE);
    return 0;
  }
  if (!opts.version) {
    io.error(USAGE);
    return 1;
  }

  const report = await validateAll(opts.version, {
    strict: opts.strict,
    writeSnapshot: opts.writeSnapshot,
    baseDir: defaults.baseDir?.(opts.version),
    reportsDir: defaults.reportsDir,
  });
  io.log(renderReport(report, opts.version, opts.reportFormat));
  return report.valid ? 0 : 1;
}
