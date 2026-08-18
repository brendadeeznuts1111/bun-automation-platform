// Thin CLI wrapper for the release docs tree.
// Implementation lives in packages/bun-validation.
//
// Usage:
//   bun docs/releases/validate.ts <version> [--strict] [--report=json|junit]
//
// Ref: https://bun.com/docs/runtime/utils#import-meta

export * from "bun-validation";

import { normalizeVersion, runCli } from "bun-validation";

if (import.meta.main) {
  const releasesDir = import.meta.dir;
  process.exit(
    await runCli(process.argv.slice(2), console, {
      baseDir: (version) => `${releasesDir}/bun-v${normalizeVersion(version)}`,
      reportsDir: `${releasesDir}/reports`,
    }),
  );
}
