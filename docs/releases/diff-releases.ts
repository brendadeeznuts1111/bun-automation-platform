// diff-releases.ts
// Compare extracted code blocks between two Bun releases to find new features.
//
// Usage:
//   bun run docs/releases/diff-releases.ts
//
// Reads:
//   docs/releases/bun-v1.3.13/extracted.json  (baseline)
//   docs/releases/bun-v1.3.14/extracted.json  (current)
//
// Prints features that are new in the current release vs the baseline.

import old from "./bun-v1.3.13/extracted.json" with { type: "json" };
import current from "./bun-v1.3.14/extracted.json" with { type: "json" };

const oldFeatures = new Set(old.code_blocks.map((b: { feature: string }) => b.feature));
const newFeatures = current.code_blocks.filter(
  (b: { feature: string }) => !oldFeatures.has(b.feature),
);

console.log(`✨ New features in ${current.release} (vs ${old.release}):`);
console.log(`   ${newFeatures.length} new feature(s)\n`);

newFeatures.forEach((b: { feature: string; purpose: string; status: string; notes: string }) => {
  console.log(`  ${b.feature}`);
  console.log(`    purpose: ${b.purpose}`);
  console.log(`    status:  ${b.status}`);
  console.log(`    notes:   ${b.notes}`);
  console.log();
});

// Also print features that existed in old but were removed/renamed
const currentFeatures = new Set(current.code_blocks.map((b: { feature: string }) => b.feature));
const removedFeatures = old.code_blocks.filter(
  (b: { feature: string }) => !currentFeatures.has(b.feature),
);

if (removedFeatures.length > 0) {
  console.log(`🗑️  Features in ${old.release} not present in ${current.release}:`);
  removedFeatures.forEach((b: { feature: string }) => console.log(`  - ${b.feature}`));
}
