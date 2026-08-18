#!/usr/bin/env bun
import { parseCliArgs, renderReport, validateAll, normalizeVersion, USAGE } from "bun-validation";

const releasesDir = `${import.meta.dir}/../releases`;
const opts = parseCliArgs(process.argv.slice(2));
if (opts.help || !opts.version) {
  console.log(USAGE);
  process.exit(opts.help ? 0 : 1);
}

const version = normalizeVersion(opts.version);
const report = await validateAll(version, {
  strict: opts.strict,
  writeSnapshot: opts.writeSnapshot,
  baseDir: `${releasesDir}/bun-v${version}`,
  reportsDir: `${releasesDir}/reports`,
});
console.log(renderReport(report, version, opts.reportFormat));
process.exit(report.valid ? 0 : 1);
