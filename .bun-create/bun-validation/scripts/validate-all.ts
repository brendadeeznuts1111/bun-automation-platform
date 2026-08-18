#!/usr/bin/env bun
// Validate every bun-v* directory under ./releases
import {
  parseCliArgs,
  renderReport,
  validateVersionsParallel,
  normalizeVersion,
  USAGE,
  CLI_VERSION,
} from "bun-validation";

const releasesDir = `${import.meta.dir}/../releases`;
const reportsDir = `${releasesDir}/reports`;

const opts = parseCliArgs(process.argv.slice(2));
if (opts.help) {
  console.log(USAGE.replace("bun-validate", "bun scripts/validate-all.ts"));
  process.exit(0);
}
if (opts.showCliVersion) {
  console.log(CLI_VERSION);
  process.exit(0);
}

const glob = new Bun.Glob("bun-v*/extracted.json");
const versions = new Set<string>();
for await (const path of glob.scan({ cwd: releasesDir, onlyFiles: true })) {
  const name = path.split("/")[0];
  if (name?.startsWith("bun-v")) versions.add(name.slice("bun-v".length));
}

const sorted = [...versions].sort();
if (sorted.length === 0) {
  console.error("No bun-v* releases found under ./releases");
  process.exit(1);
}

const results = await validateVersionsParallel(sorted, {
  strict: opts.strict,
  writeSnapshot: opts.writeSnapshot,
  concurrency: opts.concurrency ?? 4,
  reportsDir,
  baseDirFor: (version) => `${releasesDir}/bun-v${normalizeVersion(version)}`,
});

let failed = 0;
for (const { version, report } of results) {
  console.log(renderReport(report, version, opts.reportFormat));
  if (!report.valid) {
    console.error(`❌ ${version} failed`);
    failed++;
  }
}
process.exit(failed === 0 ? 0 : 1);
