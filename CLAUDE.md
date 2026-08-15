---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

### Project test configuration

- **`bunfig.toml [test]`** — preload, path ignore patterns, randomize+seed, retry, coverage (85% threshold on lines/functions)
- **`.env.test`** — auto-loaded by `bun test`, sets `NODE_ENV=test`
- **`tests/setup.ts`** — preload script: sets `DB_PATH` to a per-process temp file (so tests never touch `./data/platform.db`) and registers custom matchers
- **`tests/matchers.ts`** — custom `expect.extend()` matchers (e.g. `toBeValidAuditEntry`), available in all test files via the preload

### Pre-push hook (local CI gate)

Git hooks are per-clone (not shared via git), so each developer sets this up once:

```sh
cat > .git/hooks/pre-push << 'HOOK'
#!/bin/sh
echo "▶ pre-push: running bun test..."
if ! command -v bun >/dev/null 2>&1; then
  echo "✗ bun not found in PATH. Install Bun or bypass with: git push --no-verify"
  exit 1
fi
cd "$(git rev-parse --show-toplevel)"
output=$(bun test 2>&1)
exit_code=$?
fail_count=$(echo "$output" | awk '/[0-9]+ fail/ {print $1; exit}')
fail_count=${fail_count:-0}
pass_line=$(echo "$output" | grep -E "^[[:space:]]*[0-9]+ pass" | head -1)
if [ -z "$pass_line" ]; then
  echo "$output"
  echo "✗ bun test produced no output or crashed (exit $exit_code). Push blocked."
  echo "  Bypass with: git push --no-verify"
  exit 1
fi
if [ "$fail_count" -ne 0 ]; then
  echo "$output"
  echo "✗ bun test failed ($fail_count failures, exit $exit_code). Push blocked."
  echo "  Bypass with: git push --no-verify"
  exit 1
fi
echo "$output" | tail -15
echo "✓ bun test passed ($pass_line). Proceeding with push."
exit 0
HOOK
chmod +x .git/hooks/pre-push
```

The hook parses `N fail` from the output instead of relying on `bun test`'s exit code, because the lcov/JUnit reporters return exit 1 when no TTY is present (git hooks run without a terminal). Bypass with `git push --no-verify`.

**Important:** This is a local gate, not a replacement for server-side CI. It protects your machine from pushing broken code, but collaborators can bypass it with `git push --no-verify`. For production-grade protection, set up CI (e.g., self-hosted GitHub Actions runner or make the repo public for free GitHub Actions).

### Bun test documentation

- Test runner: https://bun.sh/docs/test
- Writing tests (API, modifiers, parametrized): https://bun.sh/docs/test/writing-tests
- Configuration (bunfig.toml `[test]`): https://bun.sh/docs/test/configuration
- Matchers & `expect.extend`: https://bun.sh/docs/test/expect
- Reporters (JUnit, dots, custom): https://bun.sh/docs/test/reporters

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
