// Validate every bun-v* release directory with bounded concurrency.
//
// Usage:
//   bun docs/releases/validate-all.ts [--strict] [--report=console|json|junit]
//   bun docs/releases/validate-all.ts --concurrency 8 --write-snapshot
//
// Ref: https://bun.com/docs/runtime/glob
// Ref: https://bun.com/docs/runtime/utils#import-meta

import {
  CLI_VERSION,
  USAGE,
  normalizeVersion,
  parseCliArgs,
  renderReport,
  validateVersionsParallel,
} from "bun-validation";

const releasesDir = import.meta.dir;
const reportsDir = `${releasesDir}/reports`;

export async function listReleaseVersions(dir = releasesDir): Promise<string[]> {
  const glob = new Bun.Glob("bun-v*/extracted.json");
  const versions = new Set<string>();
  for await (const path of glob.scan({ cwd: dir, onlyFiles: true })) {
    const name = path.split("/")[0];
    if (name?.startsWith("bun-v")) versions.add(name.slice("bun-v".length));
  }
  return [...versions].sort();
}

if (import.meta.main) {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE.replace("bun-validate", "bun docs/releases/validate-all.ts"));
    process.exit(0);
  }
  if (opts.showCliVersion) {
    console.log(CLI_VERSION);
    process.exit(0);
  }

  const versions = await listReleaseVersions();
  if (versions.length === 0) {
    console.error("No bun-v* releases found under docs/releases.");
    process.exit(1);
  }

  const concurrency = opts.concurrency ?? Number.parseInt(process.env.VALIDATE_CONCURRENCY || "4", 10);
  const results = await validateVersionsParallel(versions, {
    strict: opts.strict,
    writeSnapshot: opts.writeSnapshot,
    concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 4,
    reportsDir,
    baseDirFor: (version) => `${releasesDir}/bun-v${normalizeVersion(version)}`,
  });

  let failed = 0;
  for (const { version, report } of results) {
    console.log(`\n--- Validating ${version} ---`);
    console.log(renderReport(report, version, opts.reportFormat));
    if (!report.valid) {
      console.error(`❌ ${version} failed validation`);
      failed++;
    } else {
      console.log(`✅ ${version} passed`);
    }
  }

  if (failed > 0) {
    console.error(`\n${failed}/${versions.length} release(s) failed validation`);
    process.exit(1);
  }
  console.log(`\n✅ All ${versions.length} release(s) passed validation.`);
}
