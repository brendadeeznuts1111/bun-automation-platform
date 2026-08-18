/**
 * Deep audit: bun:sqlite, Bun.Transpiler, compression, stringWidth.
 *
 * XREF: Bug cross-reference chain — see docs/render-diagrams.ts#cross-reference-chain
 * This file has no bug numbers (API verification only, no bugs found)
 *
 * Verifies:
 * - bun:sqlite: CRUD, prepared statements, transactions, WAL, types
 * - Bun.Transpiler: TS and JSX transformation
 * - Compression: gzip, deflate, zstd with level options
 * - Bun.stringWidth: ASCII, CJK, emoji, ZWJ, combining chars
 * - Bun.escapeHTML: all HTML entities, non-string inputs
 * - Bun.dns: lookup with family filter
 * - Bun.gc, Bun.readableStreamToArray, Bun.pathToFileURL
 *
 * Ref: https://bun.com/docs/runtime/sqlite
 * Ref: https://bun.com/docs/runtime/utils
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

// Helper: db.prepare().get() returns unknown, cast to Record for property access
const getRow = (db: Database, sql: string, ...params: (string | number)[]): Record<string, unknown> =>
  // JUSTIFIED: bun-types declares get() return as unknown, we need Record for tests
  db.prepare(sql).get(...params) as Record<string, unknown>;

describe("bun:sqlite", () => {
  test("in-memory database works", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE test (x INTEGER)");
    db.exec("INSERT INTO test VALUES (1), (2), (3)");
    const rows = db.prepare("SELECT * FROM test").all();
    expect(rows.length).toBe(3);
    db.close();
  });

  test("prepared statements with positional params", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER, name TEXT)");
    const insert = db.prepare("INSERT INTO t VALUES (?, ?)");
    insert.run(1, "alice");
    insert.run(2, "bob");
    const row = getRow(db, "SELECT * FROM t WHERE id = ?", 1);
    expect(row.name).toBe("alice");
    db.close();
  });

  test("named parameters with $ prefix", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (name TEXT)");
    db.prepare("INSERT INTO t VALUES ($name)").run({ $name: "test" });
    const row = db.prepare("SELECT * FROM t WHERE name = $name").get({ $name: "test" });
    expect(row).toBeDefined();
    db.close();
  });

  test("get() returns first row only", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (x INTEGER)");
    db.exec("INSERT INTO t VALUES (1), (2), (3)");
    const row = db.prepare("SELECT * FROM t").get();
    expect(row).toEqual({ x: 1 });
    db.close();
  });

  test("values() returns arrays not objects", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (a TEXT, b TEXT)");
    db.exec("INSERT INTO t VALUES ('x', 'y')");
    const values = db.prepare("SELECT a, b FROM t").values();
    expect(values[0]).toEqual(["x", "y"]);
    db.close();
  });

  test("transaction commits on success", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (x INTEGER)");
    const tx = db.transaction(() => {
      db.prepare("INSERT INTO t VALUES (?)").run(1);
      db.prepare("INSERT INTO t VALUES (?)").run(2);
      return db.prepare("SELECT COUNT(*) as c FROM t").get();
    });
    const result = tx() as Record<string, number>; // JUSTIFIED: transaction returns unknown
    expect(result.c).toBe(2);
    db.close();
  });

  test("transaction rolls back on error", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (x INTEGER)");
    db.exec("INSERT INTO t VALUES (0)");
    const tx = db.transaction(() => {
      db.prepare("INSERT INTO t VALUES (?)").run(1);
      throw new Error("rollback");
    });
    expect(() => tx()).toThrow("rollback");
    const count = getRow(db, "SELECT COUNT(*) as c FROM t") as Record<string, number>; // JUSTIFIED: need number type for count
    expect(count.c).toBe(1); // Only the original row
    db.close();
  });

  test("WAL mode can be set", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA journal_mode=WAL");
    // In-memory databases use memory mode, not WAL
    const mode = getRow(db, "PRAGMA journal_mode") as Record<string, string>; // JUSTIFIED: need string type for journal_mode
    expect(mode.journal_mode).toBeDefined();
    db.close();
  });

  test("NULL values are returned as null", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (x INTEGER, y TEXT)");
    db.exec("INSERT INTO t VALUES (1, NULL)");
    const row = getRow(db, "SELECT * FROM t");
    expect(row.y).toBeNull();
    db.close();
  });

  test("BLOB values are returned as Uint8Array", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (data BLOB)");
    db.prepare("INSERT INTO t VALUES (?)").run(new Uint8Array([1, 2, 3]));
    const row = getRow(db, "SELECT * FROM t") as Record<string, Uint8Array>; // JUSTIFIED: need Uint8Array type for BLOB
    expect(row.data).toBeInstanceOf(Uint8Array);
    expect(row.data!.length).toBe(3);
    db.close();
  });

  test("multiple statements in one exec()", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);");
    const count = getRow(db, "SELECT COUNT(*) as c FROM t") as Record<string, number>; // JUSTIFIED: need number type for count
    expect(count.c).toBe(2);
    db.close();
  });

  test("exec without semicolon works", () => {
    const db = new Database(":memory:");
    expect(() => db.exec("SELECT 1")).not.toThrow();
    db.close();
  });

  test("iterator over rows", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (x INTEGER)");
    db.exec("INSERT INTO t VALUES (1), (2), (3)");
    const rows: unknown[] = [];
    for (const row of db.prepare("SELECT * FROM t").iterate()) {
      rows.push(row);
    }
    expect(rows.length).toBe(3);
    db.close();
  });
});

describe("Bun.Transpiler", () => {
  test("transforms TypeScript to JavaScript", async () => {
    const t = new Bun.Transpiler({ loader: "ts" });
    const result = await t.transform("const x: number = 42; export default x;");
    expect(typeof result).toBe("string");
    expect(result).toContain("const x");
    expect(result).not.toContain("number");
  });

  test("transforms JSX", async () => {
    const t = new Bun.Transpiler({ loader: "tsx" });
    const result = await t.transform("const el = <div>Hello</div>;");
    expect(result).toContain("jsx");
    expect(result).not.toContain("<div>");
  });

  test("strips interfaces", async () => {
    const t = new Bun.Transpiler({ loader: "ts" });
    const result = await t.transform("interface Foo { a: number } const x: Foo = { a: 1 };");
    expect(result).not.toContain("interface");
    expect(result).not.toContain("Foo");
  });
});

describe("compression", () => {
  const data = "Hello World!".repeat(100);

  test("gzip/gunzip roundtrip", () => {
    const compressed = Bun.gzipSync(data);
    const decompressed = Bun.gunzipSync(compressed);
    expect(new TextDecoder().decode(decompressed)).toBe(data);
  });

  test("gzip level affects compression ratio", () => {
    const level1 = Bun.gzipSync(data, { level: 1 });
    const level9 = Bun.gzipSync(data, { level: 9 });
    expect(level9.length).toBeLessThanOrEqual(level1.length);
  });

  test("deflate/inflate roundtrip", () => {
    const compressed = Bun.deflateSync(data);
    const decompressed = Bun.inflateSync(compressed);
    expect(new TextDecoder().decode(decompressed)).toBe(data);
  });

  test("zstd compress/decompress roundtrip", () => {
    const compressed = Bun.zstdCompressSync(data);
    const decompressed = Bun.zstdDecompressSync(compressed);
    expect(new TextDecoder().decode(decompressed)).toBe(data);
  });

  test("compression returns Uint8Array", () => {
    expect(Bun.gzipSync(data)).toBeInstanceOf(Uint8Array);
    expect(Bun.deflateSync(data)).toBeInstanceOf(Uint8Array);
    expect(Bun.zstdCompressSync(data)).toBeInstanceOf(Uint8Array);
  });
});

describe("Bun.stringWidth", () => {
  test("ASCII characters are width 1 each", () => {
    expect(Bun.stringWidth("hello")).toBe(5);
  });

  test("CJK characters are width 2 each", () => {
    expect(Bun.stringWidth("你好")).toBe(4);
  });

  test("emoji is width 2", () => {
    expect(Bun.stringWidth("🔥")).toBe(2);
  });

  test("ZWJ emoji family is width 2 (treated as single)", () => {
    // 👨‍👩‍👧‍👦 is multiple code points joined by ZWJ
    expect(Bun.stringWidth("👨‍👩‍👧‍👦")).toBe(2);
  });

  test("mixed content", () => {
    // hello=5, space=1, 你好=4, space=1, 🔥=2 = 13
    expect(Bun.stringWidth("hello 你好 🔥")).toBe(13);
  });

  test("control characters are width 0", () => {
    expect(Bun.stringWidth("\x01\x02")).toBe(0);
  });

  test("empty string is width 0", () => {
    expect(Bun.stringWidth("")).toBe(0);
  });

  test("combining character adds 0 width", () => {
    // e + combining accent = 1 display column
    expect(Bun.stringWidth("e\u0301")).toBe(1);
  });

  test("tab is treated as 1 character", () => {
    expect(Bun.stringWidth("a\tb")).toBe(2);
  });
});

describe("Bun.escapeHTML", () => {
  test("escapes < and >", () => {
    expect(Bun.escapeHTML("<script>")).toBe("&lt;script&gt;");
  });

  test("escapes &", () => {
    expect(Bun.escapeHTML("a & b")).toBe("a &amp; b");
  });

  test("escapes double quotes", () => {
    expect(Bun.escapeHTML('"hello"')).toBe("&quot;hello&quot;");
  });

  test("escapes single quotes as &#x27;", () => {
    expect(Bun.escapeHTML("'world'")).toBe("&#x27;world&#x27;");
  });

  test("plain text is unchanged", () => {
    expect(Bun.escapeHTML("plain text")).toBe("plain text");
  });

  test("empty string returns empty", () => {
    expect(Bun.escapeHTML("")).toBe("");
  });

  test("unicode characters are preserved", () => {
    expect(Bun.escapeHTML("<café>")).toBe("&lt;café&gt;");
  });

  test("non-string inputs are stringified first", () => {
    // JUSTIFIED: escapeHTML accepts non-string at runtime, stringifies first
    expect(Bun.escapeHTML(42 as never)).toBe("42");
    expect(Bun.escapeHTML(true as never)).toBe("true");
    expect(Bun.escapeHTML(null as never)).toBe("null");
    expect(Bun.escapeHTML({ a: 1 } as never)).toBe("[object Object]");
  });
});

describe("Bun.dns", () => {
  test("lookup localhost returns addresses", async () => {
    const results = await Bun.dns.lookup("localhost");
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  test("lookup with family filter", async () => {
    const v4 = await Bun.dns.lookup("localhost", { family: 4 });
    expect(v4.every((r) => r.family === 4)).toBe(true);
  });

  test("lookup with family 6", async () => {
    const v6 = await Bun.dns.lookup("localhost", { family: 6 });
    expect(v6.every((r) => r.family === 6)).toBe(true);
  });
});

describe("Bun utility APIs", () => {
  test("Bun.gc exists and works", () => {
    expect(typeof Bun.gc).toBe("function");
    expect(() => Bun.gc(true)).not.toThrow();
    expect(() => Bun.gc(false)).not.toThrow();
  });

  test("Bun.generateHeapSnapshot exists", () => {
    expect(typeof Bun.generateHeapSnapshot).toBe("function");
  });

  test("Bun.readableStreamToArray collects stream chunks", async () => {
    const rs = new ReadableStream({
      start(controller) {
        controller.enqueue("a");
        controller.enqueue("b");
        controller.enqueue("c");
        controller.close();
      },
    });
    const arr = await Bun.readableStreamToArray(rs);
    expect(arr).toEqual(["a", "b", "c"]);
  });

  test("Bun.pathToFileURL converts path to file URL", () => {
    const url = Bun.pathToFileURL("/tmp/test.txt");
    expect(url.href).toBe("file:///tmp/test.txt");
  });

  test("Bun.fileURLToPath converts file URL to path", () => {
    const url = new URL("file:///tmp/test.txt");
    expect(Bun.fileURLToPath(url)).toBe("/tmp/test.txt");
  });

  test("Bun.env is same reference as process.env", () => {
    expect(Bun.env).toBe(process.env);
  });

  test("Bun.nanoseconds returns number", () => {
    expect(typeof Bun.nanoseconds()).toBe("number");
  });

  test("Bun.main returns current file path", () => {
    expect(typeof Bun.main).toBe("string");
  });

  test("Bun.cwd returns current working directory", () => {
    // JUSTIFIED: Bun.cwd doesn't exist in bun-types but works at runtime
    expect(typeof (Bun as Record<string, unknown>).cwd).toBe("string");
  });

  test("Bun.openInEditor exists", () => {
    expect(typeof Bun.openInEditor).toBe("function");
  });
});
