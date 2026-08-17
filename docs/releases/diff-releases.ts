// diff-releases.ts
// Compare extracted code blocks between two Bun releases to find new features.
//
// Usage:
//   bun run docs/releases/diff-releases.ts [old_version] [new_version]
//
// Defaults to comparing v1.3.13 → v1.3.14.
// Uses Bun.file().json() for one-liner reads — no fs/promises import needed.

interface CodeBlock {
  id: number;
  feature: string;
  code: string;
  purpose: string;
  status: string;
  notes: string;
}

interface ExtractedRelease {
  release: string;
  published: string;
  source: string;
  code_blocks: CodeBlock[];
}

const oldVersion = process.argv[2] ?? "bun-v1.3.13";
const newVersion = process.argv[3] ?? "bun-v1.3.14";

// Bun.file().json() — reads and parses in one call, no import statement
// JUSTIFIED: Bun.file().json() returns Promise<unknown>; narrowing to our
// ExtractedRelease interface is safe because we control the JSON schema.
// JUSTIFIED: same as above — narrowing the current release JSON
const old = await Bun.file(`${import.meta.dir}/${oldVersion}/extracted.json`).json() as ExtractedRelease;
// JUSTIFIED: same as above — narrowing the current release JSON
const current = await Bun.file(`${import.meta.dir}/${newVersion}/extracted.json`).json() as ExtractedRelease;

const oldFeatures = new Set(old.code_blocks.map((b) => b.feature));
const newFeatures = current.code_blocks.filter((b) => !oldFeatures.has(b.feature));

console.log(`✨ New features in ${current.release} (vs ${old.release}):`);
console.log(`   ${newFeatures.length} new feature(s)\n`);

newFeatures.forEach((b) => {
  console.log(`  ${b.feature}`);
  console.log(`    purpose: ${b.purpose}`);
  console.log(`    status:  ${b.status}`);
  console.log(`    notes:   ${b.notes}`);
  console.log();
});

// Features that existed in old but were removed/renamed
const currentFeatures = new Set(current.code_blocks.map((b) => b.feature));
const removedFeatures = old.code_blocks.filter((b) => !currentFeatures.has(b.feature));

if (removedFeatures.length > 0) {
  console.log(`🗑️  Features in ${old.release} not present in ${current.release}:`);
  removedFeatures.forEach((b) => console.log(`  - ${b.feature}`));
}

// Changed features (same name, different code)
const changedFeatures = current.code_blocks.filter((b) => {
  const oldBlock = old.code_blocks.find((p) => p.feature === b.feature);
  return oldBlock && oldBlock.code !== b.code;
});

if (changedFeatures.length > 0) {
  console.log(`\n🔄 Changed features (same name, updated code):`);
  changedFeatures.forEach((b) => console.log(`  - ${b.feature}`));
}
