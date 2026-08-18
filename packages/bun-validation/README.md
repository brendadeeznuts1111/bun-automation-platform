# bun-validation

Zero-dependency Bun-native validator for release ingest artifacts
(`extracted.json` + `normalized.json`). This is the workspace **crate**.

## Install

**This monorepo** (already wired):

```json
{ "dependencies": { "bun-validation": "workspace:*" } }
```

**Another project** (local file until published):

```sh
bun add file:../artifacts-browser/packages/bun-validation
```

**After publish:**

```sh
bun add bun-validation
# or globally:
bun add -g bun-validation
```

## API

```ts
import { validateAll } from "bun-validation";

const report = await validateAll("1.3.14", {
  baseDir: "docs/releases/bun-v1.3.14",
});
```

## CLI

```sh
bun-validate 1.3.14 --strict --report=json
bun-validate -V
```

Root scripts: `bun run validate -- 1.3.14` and `bun run validate:all`.

## Scaffold a new project

`bun init` has no `--template` flag. Use one of:

```sh
# Full starter (scripts, sample release, CI)
bun create bun-validation ./my-validator

# Layer the crate onto `bun init -y`
bun scripts/init-validation.ts ./my-app
```

## Publish (optional)

Unset `"private": true`, then `bun publish` from `packages/bun-validation`.
