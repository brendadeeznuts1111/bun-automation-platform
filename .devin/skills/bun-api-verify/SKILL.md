---
name: bun-api-verify
description: Verify Bun API calls against installed docs and type definitions before writing code
argument-hint: "<API name or file path>"
allowed-tools:
  - read
  - grep
  - glob
  - exec
triggers:
  - user
  - model
---

# Bun API Verification Skill

You are about to write or modify code that calls a Bun API. Before writing
any code, you MUST verify the API usage against the canonical sources.

## Step 1: Identify the API

Determine which Bun API the code will call (e.g. `Bun.WebView`, `Bun.serve`,
`bun:sqlite`, `Bun.CSRF`, `Bun.Image`, `Bun.spawn`, `Bun.password`).

## Step 2: Read the documentation

Read the corresponding `.mdx` file from the installed bun-types docs:

```sh
# Find the doc file
find node_modules/bun-types/docs -iname "*<api-name>*"

# Read it
cat node_modules/bun-types/docs/runtime/<api>.mdx
```

Pay attention to:
- Constructor options and their types
- Method signatures and return types
- Error handling behavior
- Concurrency model (what can run in parallel, what can't)
- Platform limitations (macOS vs Linux, version requirements)

## Step 3: Read the type definitions

Read the TypeScript definitions to confirm the API matches the docs:

```sh
# Search for the API in the type definitions
grep -A 20 "class WebView" node_modules/bun-types/bun.d.ts
grep -A 20 "interface CSRFGenerateOptions" node_modules/bun-types/bun.d.ts
```

The type definitions are the **source of truth**. If the docs and types
disagree, the types win. If a property doesn't exist in the types, it
doesn't exist in the API.

## Step 4: Check for type cast violations

Before writing the code, check: will this require a type cast (`as`)?

- **No** — the types match your intended usage. Proceed.
- **Yes** — STOP. Do not write a type cast. Instead:
  1. Re-read the type definition to understand why the types don't match
  2. Redesign the code to work within the actual type system
  3. If the types are genuinely wrong (bug in bun-types), document why
     with a `// JUSTIFIED:` comment citing the specific type def line

## Step 5: Write the code

Write the code with a doc reference comment:
```ts
// Ref: node_modules/bun-types/docs/runtime/<api>.mdx#<section>
```

## Step 6: Verify

Run `bunx tsc --noEmit` to confirm the code type-checks without casts.
If it fails, go back to Step 2.
