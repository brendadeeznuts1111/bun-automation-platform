// ingest-release.ts
// Full ingestion pipeline: fetch blog → save markdown → normalize → diff.
//
// Usage:
//   bun run docs/releases/ingest-release.ts <version>
//
// Example:
//   bun run docs/releases/ingest-release.ts 1.3.15
//
// Steps:
//   1. Fetch blog markdown via Jina Reader (r.jina.ai) using native fetch
//   2. Save to docs/releases/bun-v<version>/blog.md (Bun.write auto-creates dirs)
//   3. Check for extracted.json (created manually or via future extract.ts)
//   4. Normalize extracted.json → normalized.json (inline import, no subprocess)
//   5. Diff against previous release (inline, no subprocess)
//   6. Validate extracted + normalized output (shape, semantics, consistency)
//
// All I/O uses Bun-native APIs: fetch, Bun.write, Bun.file().json().
// Zero external dependencies (no curl, no fs/promises, no mkdir).

const version = process.argv[2];
if (!version) {
  console.error("Usage: bun run docs/releases/ingest-release.ts <version>");
  console.error("Example: bun run docs/releases/ingest-release.ts 1.3.15");
  process.exit(1);
}

const releaseDir = `${import.meta.dir}/bun-v${version}`;
const jinaUrl = `https://r.jina.ai/https://bun.com/blog/bun-v${version}`;

console.log(`📦 Ingesting bun-v${version}...`);

// Step 1: Fetch blog markdown via Jina Reader using native fetch
// No curl dependency — Bun's fetch is optimized and cross-platform.
// Bun.write auto-creates parent directories, so no mkdir needed.
console.log(`\n1️⃣  Fetching blog from ${jinaUrl}...`);
try {
  const response = await fetch(jinaUrl, { verbose: false });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  // Bun.write accepts a Response object directly — streams body to disk.
  // Auto-creates releases/bun-v<version>/ directory if it doesn't exist.
  const blogPath = `${releaseDir}/blog.md`;
  await Bun.write(blogPath, response);
  const bytes = await Bun.file(blogPath).size;
  console.log(`   ✅ Saved ${bytes.toLocaleString()} bytes → ${blogPath}`);
} catch (err) {
  console.error(`   ❌ Failed to fetch blog: ${err}`);
  process.exit(1);
}

// Step 2: Check if extracted.json exists
// extracted.json is created manually (or via a future extract.ts script)
// by parsing the blog markdown into structured code_blocks.
const extractedFile = Bun.file(`${releaseDir}/extracted.json`);
if (!(await extractedFile.exists())) {
  console.log(`\n⚠️  ${releaseDir}/extracted.json not found.`);
  console.log(`   The blog has been saved to ${releaseDir}/blog.md.`);
  console.log(`   Create extracted.json from the blog content, then re-run:`);
  console.log(`   bun run docs/releases/normalize.ts bun-v${version}`);
  process.exit(0);
}

// Step 3: Normalize extracted.json → normalized.json
// Inline import avoids subprocess stdio hanging. normalizeRelease() is
// exported from normalize.ts and uses Bun.file().json() + Bun.write().
console.log(`\n2️⃣  Normalizing extracted.json...`);
const { normalizeRelease } = await import(`${import.meta.dir}/normalize.ts`);
await normalizeRelease(`bun-v${version}`);

// Step 4: Find previous version and diff (inline, not subprocess)
console.log(`\n3️⃣  Diffing against previous release...`);
const releasesDir = import.meta.dir;
// Bun.Glob only matches files, not directories — use readdirSync for dirs.
const { readdirSync } = await import("node:fs");
const dirs = readdirSync(releasesDir)
  .filter((d) => d.startsWith("bun-v") && d !== `bun-v${version}`)
  .sort();

if (dirs.length > 0) {
  const prevVersion = dirs[dirs.length - 1];
  console.log(`   Comparing ${prevVersion} → bun-v${version}`);
  // Inline diff — read both JSONs and compare feature sets.
  // JUSTIFIED: Bun.file().json() returns Promise<unknown>; narrowing to our
  // interface is safe because we control the JSON schema.
  // JUSTIFIED: same as above — prev release JSON
  const prevData = (await Bun.file(`${releasesDir}/${prevVersion}/extracted.json`).json()) as {
    code_blocks: { feature: string }[];
  };
  // JUSTIFIED: same as above — current release JSON
  const currData = (await Bun.file(`${releaseDir}/extracted.json`).json()) as {
    code_blocks: { feature: string; purpose: string; status: string; notes: string }[];
  };
  const prevFeatures = new Set(prevData.code_blocks.map((b) => b.feature));
  const newFeatures = currData.code_blocks.filter((b) => !prevFeatures.has(b.feature));
  console.log(`   ${newFeatures.length} new feature(s):`);
  newFeatures.forEach((b) => console.log(`     + ${b.feature}`));
} else {
  console.log(`   No previous release found — skipping diff.`);
}

// Step 5: Semantic + consistency validation of extracted/normalized output
console.log(`\n4️⃣  Validating output...`);
const { validateAll } = await import("bun-validation");
const report = await validateAll(version, {
  baseDir: releaseDir,
  reportsDir: `${import.meta.dir}/reports`,
});
if (!report.valid) {
  console.error("❌ Validation failed.");
  console.error(report.errors.join("\n"));
  process.exit(1);
}
console.log("✅ Validation passed.");

console.log(`\n✅ Ingestion complete for bun-v${version}`);
