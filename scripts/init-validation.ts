#!/usr/bin/env bun
// Layer bun-validation onto `bun init -y` in a target folder.
//
// Usage:
//   bun scripts/init-validation.ts [dest]
//
// `bun init` has no --template flag. This script is the equivalent:
// init a Bun project, then add the workspace crate + starter scripts.
//
// For a full copy of the create template, prefer:
//   bun create bun-validation ./my-app
//
// Ref: https://bun.com/docs/cli/bun-init
// Ref: https://bun.com/docs/cli/bun-create

const dest = process.argv[2] ?? ".";
const destAbs = dest.startsWith("/") ? dest : `${process.cwd()}/${dest}`.replace(/\/\.$/, "") || process.cwd();
const crateAbs = `${import.meta.dir}/../packages/bun-validation`;
const templateAbs = `${import.meta.dir}/../.bun-create/bun-validation`;

await Bun.write(`${destAbs}/.gitkeep`, "");

const pkgPath = `${destAbs}/package.json`;
if (!(await Bun.file(pkgPath).exists())) {
  console.log(`📦 bun init -y in ${destAbs}`);
  const init = Bun.spawn(["bun", "init", "-y"], {
    cwd: destAbs,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await init.exited;
  if (code !== 0) process.exit(code);
}

console.log(`➕ bun add file:${crateAbs}`);
const add = Bun.spawn(["bun", "add", `file:${crateAbs}`], {
  cwd: destAbs,
  stdout: "inherit",
  stderr: "inherit",
});
if ((await add.exited) !== 0) process.exit(1);

const raw = await Bun.file(pkgPath).json();
if (!isRecord(raw)) {
  console.error("package.json is not an object");
  process.exit(1);
}
const scripts = isRecord(raw.scripts) ? raw.scripts : {};
raw.scripts = {
  ...scripts,
  validate: scripts.validate ?? "bun-validate",
  "validate:all": scripts["validate:all"] ?? "bun scripts/validate-all.ts",
  ci: scripts.ci ?? "bun run validate:all && bun test",
};
await Bun.write(pkgPath, `${JSON.stringify(raw, null, 2)}\n`);

await copyIfMissing(`${templateAbs}/scripts/validate-all.ts`, `${destAbs}/scripts/validate-all.ts`);
await copyIfMissing(
  `${templateAbs}/releases/bun-v0.0.0/extracted.json`,
  `${destAbs}/releases/bun-v0.0.0/extracted.json`,
);
await copyIfMissing(
  `${templateAbs}/releases/bun-v0.0.0/normalized.json`,
  `${destAbs}/releases/bun-v0.0.0/normalized.json`,
);

console.log(`\n✅ Validation crate ready in ${destAbs}`);
console.log(`   bun run validate -- 0.0.0`);
console.log(`   bun run validate:all`);

function isRecord(obj: unknown): obj is Record<string, unknown> {
  return typeof obj === "object" && obj !== null;
}

async function copyIfMissing(from: string, to: string): Promise<void> {
  if (await Bun.file(to).exists()) return;
  const text = await Bun.file(from).text();
  await Bun.write(to, text);
}
