/**
 * Database layer — SQLite via bun:sqlite.
 *
 * Uses WAL mode for concurrent reads, a single writer connection
 * (SQLite serializes writes), and a separate read-only connection pool.
 * Migrations run on boot; schema version tracked in _meta table.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MetaRow } from "../types/models";

const DB_PATH = resolve(process.env.DB_PATH ?? "./data/platform.db");

// Ensure the data directory exists.
mkdirSync(dirname(DB_PATH), { recursive: true });

// --- Connections -----------------------------------------------------------

/** Writer connection — serialized via a mutex (SQLite limitation). */
const writer = new Database(DB_PATH);
writer.exec("PRAGMA journal_mode = WAL;");
writer.exec("PRAGMA foreign_keys = ON;");
writer.exec("PRAGMA busy_timeout = 5000;");

/** Reader pool — N read-only connections for concurrent SELECTs.
 *  Opened lazily after the writer creates the DB file + schema. */
const READER_COUNT = parseInt(process.env.DB_READERS ?? "4", 10);
const readers: Database[] = [];
let readerIdx = 0;

function ensureReaders(): void {
  if (readers.length > 0) return;
  for (let i = 0; i < READER_COUNT; i++) {
    const r = new Database(DB_PATH, { readonly: true });
    // G8: Don't set PRAGMA journal_mode on readonly connections — it throws
    // "attempt to write a readonly database". The writer already sets WAL mode
    // on the database file, and readers inherit it automatically.
    // E5: Match the writer's busy_timeout so reads don't fail immediately
    // when a write is in progress (WAL allows concurrent reads, but checkpoint
    // operations can briefly lock pages).
    r.exec("PRAGMA busy_timeout = 5000;");
    readers.push(r);
  }
}

function getReader(): Database {
  ensureReaders();
  const r = readers[readerIdx % readers.length]!;
  readerIdx++;
  return r;
}

// --- Write mutex -----------------------------------------------------------

let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * Run a write operation (INSERT/UPDATE/DELETE) on the writer connection.
 * Writes are serialized via a promise chain — SQLite only allows one writer.
 */
export function write<T>(fn: (db: Database) => T): Promise<T> {
  const run = writeQueue.then(() => fn(writer));
  writeQueue = run.catch(() => {});
  // JUSTIFIED: writeQueue is Promise<unknown> for chaining; narrowing to Promise<T>
  return run as Promise<T>;
}

/** Run a read operation (SELECT) on a pooled reader connection. */
export function read<T>(fn: (db: Database) => T): T {
  return fn(getReader());
}

// --- Migrations ------------------------------------------------------------

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS _meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        username    TEXT NOT NULL UNIQUE,
        password    TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id    INTEGER NOT NULL REFERENCES agents(id),
        url         TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        progress    INTEGER NOT NULL DEFAULT 0,
        priority    INTEGER NOT NULL DEFAULT 0,
        proxy       TEXT,
        user_agent  TEXT,
        geo_lat     REAL,
        geo_lon     REAL,
        error       TEXT,
        result      TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
        started_at  TEXT,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority DESC, created_at ASC);

      CREATE TABLE IF NOT EXISTS sessions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id      INTEGER NOT NULL REFERENCES tasks(id),
        cookies      TEXT NOT NULL DEFAULT '{}',
        local_storage TEXT NOT NULL DEFAULT '{}',
        session_storage TEXT NOT NULL DEFAULT '{}',
        screenshot_path TEXT,
        screenshot_color TEXT,
        expires_at   TEXT,
        last_healthy TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id);

      CREATE TABLE IF NOT EXISTS credentials (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id    INTEGER NOT NULL REFERENCES agents(id),
        site        TEXT NOT NULL,
        username_enc TEXT NOT NULL,
        password_enc TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(agent_id, site)
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id    INTEGER,
        action      TEXT NOT NULL,
        resource    TEXT,
        details     TEXT,
        ip_address  TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent_id);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

      CREATE TABLE IF NOT EXISTS health_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          INTEGER NOT NULL,
        pool_status TEXT NOT NULL,
        uptime      REAL NOT NULL,
        bun_version TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_health_ts ON health_log(ts DESC);

      CREATE TABLE IF NOT EXISTS rate_limits (
        key         TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        count       INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (key, window_start)
      );

      CREATE TABLE IF NOT EXISTS circuit_breakers (
        site        TEXT PRIMARY KEY,
        failures    INTEGER NOT NULL DEFAULT 0,
        tripped_at  TEXT,
        last_failure TEXT
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id    INTEGER NOT NULL REFERENCES agents(id),
        token       TEXT NOT NULL UNIQUE,
        csrf_token  TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at  TEXT NOT NULL DEFAULT (datetime('now', '+24 hours'))
      );

      CREATE INDEX IF NOT EXISTS idx_auth_sessions_agent ON auth_sessions(agent_id);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_token ON auth_sessions(token);
    `,
  },
];

export function migrate(): void {
  // Run migrations synchronously on the writer connection (before server starts)
  writer.exec("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");

  const row = writer.query("SELECT value FROM _meta WHERE key = 'schema_version'").as(MetaRow).get();
  const currentVersion = row ? parseInt(row.value, 10) : 0;

  for (const m of MIGRATIONS) {
    if (m.version > currentVersion) {
      // E4: Wrap each migration in a transaction. If any statement fails,
      // the entire migration rolls back — no partial schema changes left behind.
      writer.exec("BEGIN");
      try {
        writer.exec(m.sql);
        writer
          .query("INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)")
          .run(m.version.toString());
        writer.exec("COMMIT");
        console.log(`[db] migrated to schema version ${m.version}`);
      } catch (err) {
        writer.exec("ROLLBACK");
        console.error(`[db] migration ${m.version} failed, rolled back:`, err);
        throw err;
      }
    }
  }

  // Now that the DB file + schema exist, initialize reader pool
  ensureReaders();
}

// --- Cleanup ---------------------------------------------------------------

/**
 * Close all database connections.
 *
 * The writer and reader connections are module-scoped (long-lived for the
 * server's entire lifetime), so we use manual close() instead of `using`.
 * Note: `using db = new Database(...)` calls close(true), which throws
 * "database is locked" if prepared statements are still outstanding.
 * Manual close() (without args) is safer — it lets statements finalize
 * gracefully via GC.
 */
export function closeDB(): void {
  for (const r of readers)
    try {
      r.close();
    } catch {}
  try {
    writer.close();
  } catch {}
}
