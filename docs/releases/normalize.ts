// normalize.ts
// Enrich extracted.json with API references, runnable flag, and stable IDs.
//
// Usage:
//   bun run docs/releases/normalize.ts [version]
//
// Reads:  docs/releases/<version>/extracted.json
// Writes: docs/releases/<version>/normalized.json
//
// Uses Bun.file().json() + Bun.write() — no fs/promises needed.

interface RawBlock {
  id: number;
  feature: string;
  code: string;
  purpose: string;
  status: string;
  notes: string;
}

interface NormalizedBlock {
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
}

interface ExtractedRelease {
  release: string;
  code_blocks: RawBlock[];
}

/**
 * Normalize extracted.json for a given release version.
 * Enriches with API references, runnable flag, stable IDs, and dependencies.
 * Uses Bun.file().json() + Bun.write() — no fs/promises needed.
 *
 * @param version Release dir name, e.g. "bun-v1.3.14"
 * @returns Path to the written normalized.json
 */
export async function normalizeRelease(version: string): Promise<string> {
  const releaseDir = `${import.meta.dir}/${version}`;

  // JUSTIFIED: Bun.file().json() returns Promise<unknown>; narrowing to
  // ExtractedRelease is safe because we control the JSON schema.
  // JUSTIFIED: narrowing unknown to ExtractedRelease (controlled schema)
  const raw = (await Bun.file(`${releaseDir}/extracted.json`).json()) as ExtractedRelease;

  // Extract version number from release string (e.g. "bun-v1.3.14" → "1.3.14")
  const versionNum = raw.release.replace(/^bun-v/, "");

  const normalized: NormalizedBlock[] = raw.code_blocks.map((block, i) => {
    // Extract API references from code (Bun.*, process.*, fs.*, etc.)
    const api = [...block.code.matchAll(/(?:Bun\.|process\.|fs\.|tls\.|crypto\.|console\.)(?:[A-Za-z0-9_]+)/g)].map(
      (m) => m[0],
    );
    const uniqueApi = [...new Set(api)];

    // Determine if code is runnable (not just config or a shell command)
    const runnable =
      !/\.(jpg|png|txt|json|toml|env|md)/.test(block.code) &&
      !block.code.includes("...") &&
      !block.code.includes("<") &&
      !block.code.includes("your-") &&
      !block.code.trim().startsWith("#") && // shell/config comments
      !block.code.trim().startsWith("["); // toml/config blocks

    // Extract dependencies (env vars)
    const dependencies: string[] = [];
    const envMatches = block.code.matchAll(/BUN_FEATURE_FLAG_[A-Z_]+/g);
    for (const m of envMatches) dependencies.push(m[0]);

    const slug = block.feature
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    return {
      id: `bun-${versionNum}-${slug}-${i + 1}`,
      feature: block.feature,
      code: block.code,
      purpose: block.purpose,
      status: block.status,
      notes: block.notes,
      api: uniqueApi,
      dependencies,
      runnable,
      added_in: versionNum,
    };
  });

  // Bun.write auto-creates parent directories — no mkdir needed
  const outPath = `${releaseDir}/normalized.json`;
  await Bun.write(outPath, JSON.stringify(normalized, null, 2));
  console.log(`✅ Normalized ${normalized.length} blocks → ${outPath}`);

  // Print summary
  const runnableCount = normalized.filter((b) => b.runnable).length;
  const apiUsage = new Map<string, number>();
  for (const block of normalized) {
    for (const api of block.api) {
      apiUsage.set(api, (apiUsage.get(api) ?? 0) + 1);
    }
  }

  console.log(`\n📊 Summary:`);
  console.log(`   Total blocks:    ${normalized.length}`);
  console.log(`   Runnable:        ${runnableCount}`);
  console.log(`   Not runnable:    ${normalized.length - runnableCount}`);
  console.log(`   Unique APIs:     ${apiUsage.size}`);
  console.log(`\n🔧 Top APIs:`);
  [...apiUsage.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([api, count]) => console.log(`   ${count}x  ${api}`));

  return outPath;
}

// Run standalone if invoked directly (not imported)
if (import.meta.path === process.argv[1]) {
  const version = process.argv[2] ?? "bun-v1.3.14";
  await normalizeRelease(version);
}
