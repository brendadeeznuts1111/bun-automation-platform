/**
 * Test preload — runs before any test file is imported.
 *
 * `bun test` loads all --preload scripts first, then runs every test file
 * in one shared global (per the Bun test docs). Setting env vars here
 * guarantees they are in place before src/db/index.ts reads DB_PATH at
 * module-load time.
 *
 * Static test env (NODE_ENV=test) lives in .env.test, which `bun test`
 * auto-loads. This preload only handles the per-process DB_PATH that
 * .env.test can't (a static path there would collide across
 * `bun test --parallel` workers).
 *
 * Wired via bunfig.toml: [test] preload = ["./tests/setup.ts"]
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

// Register custom bun:test matchers (expect.extend) so they're available in
// every test file without per-file imports. See tests/matchers.ts.
import "./matchers";

// Isolate the SQLite DB per test process so runs never touch ./data/platform.db.
// Override unconditionally: .env.development sets DB_PATH=./data/platform.db at
// Bun startup (before preload runs), and ??= would leave that in place.
// Include PID + a random suffix so parallel `bun test --parallel` workers
// don't collide on the same file.
process.env.DB_PATH = join(tmpdir(), `bun-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}.db`);
