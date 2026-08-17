// ingest-release.ts
// Full ingestion pipeline: fetch blog → save markdown → (manual extract) → normalize.
//
// Usage:
//   bun run docs/releases/ingest-release.ts <version>
//
// Example:
//   bun run docs/releases/ingest-release.ts 1.3.14
//
// Steps:
//   1. Fetch blog markdown via Jina Reader (r.jina.ai)
//   2. Save to docs/releases/bun-v<version>/blog.md
//   3. Run normalize.ts to enrich extracted.json → normalized.json
//   4. Run diff-releases.ts against the previous version
//
// NOTE: Step 2 assumes extracted.json already exists (created manually or via
// a future extraction script). The normalize step enriches it with API refs,
// runnable flags, and stable IDs.

const version = process.argv[2];
if (!version) {
  console.error("Usage: bun run docs/releases/ingest-release.ts <version>");
  console.error("Example: bun run docs/releases/ingest-release.ts 1.3.14");
  process.exit(1);
}

const releaseDir = `${import.meta.dir}/bun-v${version}`;
const blogUrl = `https://bun.com/blog/bun-v${version}`;
const jinaUrl = `https://r.jina.ai/${blogUrl}`;

console.log(`📦 Ingesting bun-v${version}...`);

// Step 1: Fetch blog markdown via Jina Reader
console.log(`\n1️⃣  Fetching blog from ${jinaUrl}...`);
try {
  // Bun.$ — shell commands with automatic escaping, no separate .sh file
  await Bun.$`curl -s ${jinaUrl} -o ${releaseDir}/blog.md`;
  const stats = Bun.file(`${releaseDir}/blog.md`);
  console.log(`   ✅ Saved ${(await stats.size).toLocaleString()} bytes → ${releaseDir}/blog.md`);
} catch (err) {
  console.error(`   ❌ Failed to fetch blog: ${err}`);
  process.exit(1);
}

// Step 2: Check if extracted.json exists
const extractedFile = Bun.file(`${releaseDir}/extracted.json`);
if (!(await extractedFile.exists())) {
  console.log(`\n⚠️  ${releaseDir}/extracted.json not found.`);
  console.log(`   Create it manually from the blog content, then re-run:`);
  console.log(`   bun run docs/releases/normalize.ts bun-v${version}`);
  process.exit(0);
}

// Step 3: Normalize extracted.json → normalized.json (inline import, no subprocess)
console.log(`\n2️⃣  Normalizing extracted.json...`);
const { normalizeRelease } = await import(`${import.meta.dir}/normalize.ts`);
await normalizeRelease(`bun-v${version}`);

// Step 4: Find previous version and diff (inline, not subprocess)
console.log(`\n3️⃣  Diffing against previous release...`);
const releasesDir = import.meta.dir;
// Bun.Glob only matches files, not directories — use readdirSync for dirs
const { readdirSync } = await import("node:fs");
const dirs = readdirSync(releasesDir)
  .filter((d) => d.startsWith("bun-v") && d !== `bun-v${version}`)
  .sort();

if (dirs.length > 0) {
  const prevVersion = dirs[dirs.length - 1];
  console.log(`   Comparing ${prevVersion} → bun-v${version}`);
  // Inline diff — read both JSONs and compare
  // JUSTIFIED: Bun.file().json() returns Promise<unknown>; narrowing to our
  // interface is safe because we control the JSON schema.
  // JUSTIFIED: same as above — prev release JSON
  const prevData = await Bun.file(`${releasesDir}/${prevVersion}/extracted.json`).json() as { code_blocks: { feature: string }[] };
  // JUSTIFIED: same as above — current release JSON
  const currData = await Bun.file(`${releaseDir}/extracted.json`).json() as { code_blocks: { feature: string; purpose: string; status: string; notes: string }[] };
  const prevFeatures = new Set(prevData.code_blocks.map((b) => b.feature));
  const newFeatures = currData.code_blocks.filter((b) => !prevFeatures.has(b.feature));
  console.log(`   ${newFeatures.length} new feature(s):`);
  newFeatures.forEach((b) => console.log(`     + ${b.feature}`));
} else {
  console.log(`   No previous release found — skipping diff.`);
}

console.log(`\n✅ Ingestion complete for bun-v${version}`);
