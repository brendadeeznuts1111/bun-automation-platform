import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";

describe("Bun Native APIs & Utilities", () => {
  it("Bun.password hashes and verifies with Argon2id", async () => {
    const secret = "platform-secure-pass-123";
    const hash = await Bun.password.hash(secret);
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await Bun.password.verify(secret, hash)).toBe(true);
    expect(await Bun.password.verify("wrong-password", hash)).toBe(false);
  });

  it("Bun.CSRF generates and verifies HMAC tokens", () => {
    const secret = "test-csrf-secret-key-32-bytes-ok";
    const token = Bun.CSRF.generate(secret, { expiresIn: 3600, algorithm: "sha256" });
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(20);

    const isValid = Bun.CSRF.verify(token, { secret, algorithm: "sha256" });
    expect(isValid).toBe(true);

    const isInvalidSecret = Bun.CSRF.verify(token, { secret: "wrong-secret-key", algorithm: "sha256" });
    expect(isInvalidSecret).toBe(false);
  });

  it("Bun.color converts and validates color formats", () => {
    expect(Bun.color("#3b82f6", "hex")).toBe("#3b82f6");
    expect(Bun.color("#ff0080", "rgb")).toBe("rgb(255, 0, 128)");
    expect(Bun.color("#ff0080", "number")).toBe(16711808);
    expect(Bun.color("invalid-color-string")).toBeNull();
  });

  it("Bun.deflateSync and Bun.inflateSync roundtrip correctly", () => {
    const original = new Uint8Array(1024).map((_, i) => (i * 17) % 256);
    const compressed = Bun.deflateSync(original.buffer as ArrayBuffer);
    expect(compressed.length).toBeLessThan(original.length);

    const decompressed = Bun.inflateSync(compressed.buffer as ArrayBuffer);
    expect(decompressed).toEqual(original);
  });

  it("Bun.hash calculates checksums correctly", () => {
    const buf = Buffer.from("bun-automation-platform");
    const crc = Bun.hash.crc32(buf);
    const adler = Bun.hash.adler32(buf);
    const wy = Bun.hash.wyhash(buf);

    expect(typeof crc).toBe("number");
    expect(typeof adler).toBe("number");
    expect(typeof wy).toBe("bigint");
    expect(crc).toBeGreaterThan(0);
    expect(adler).toBeGreaterThan(0);
  });

  it("Bun.markdown renders HTML, ANSI, and custom callbacks", () => {
    const markdown = "# Title\n\n**bold** and ~~strike~~ and [link](https://bun.com)";

    const html = Bun.markdown.html(markdown);
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<del>strike</del>");

    const ansi = Bun.markdown.ansi("# Terminal Title", { colors: false });
    expect(ansi).toContain("Terminal Title");

    const custom = Bun.markdown.render(markdown, {
      strong: (children) => `__${children}__`,
    });
    expect(custom).toContain("__bold__");
  });

  it("bun:sqlite executes prepared statements and transactions", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);");

    const insert = db.prepare("INSERT INTO items (name) VALUES (?) RETURNING id;");
    const r1 = insert.get("Alpha") as { id: number };
    const r2 = insert.get("Beta") as { id: number };

    expect(r1.id).toBe(1);
    expect(r2.id).toBe(2);

    const all = db.query("SELECT * FROM items ORDER BY id ASC;").all();
    expect(all.length).toBe(2);
    db.close();
  });

  it("Bun.file and Bun.write perform zero-copy file operations", async () => {
    const path = `/tmp/bun-test-${Date.now()}.txt`;
    await Bun.write(path, "Bun File Content");

    const file = Bun.file(path);
    expect(await file.exists()).toBe(true);
    expect(file.size).toBe(16);
    expect(await file.text()).toBe("Bun File Content");
  });

  it("Native using / Symbol.dispose runs cleanup deterministically", () => {
    let cleaned = false;
    {
      using _guard = {
        [Symbol.dispose]() {
          cleaned = true;
        },
      };
      expect(cleaned).toBe(false);
    }
    expect(cleaned).toBe(true);
  });

  it("Bun.gzipSync and Bun.gunzipSync roundtrip correctly", () => {
    const raw = Buffer.from("gzip-compression-test-payload");
    const gz = Bun.gzipSync(raw);
    expect(gz.length).toBeGreaterThan(10);
    const gunzipped = Bun.gunzipSync(gz);
    expect(Buffer.from(gunzipped).toString()).toBe("gzip-compression-test-payload");
  });

  it("Bun.escapeHTML escapes dangerous HTML entities", () => {
    const dangerous = `<script>alert("xss") & test</script>`;
    const safe = Bun.escapeHTML(dangerous);
    expect(safe).toBe(`&lt;script&gt;alert(&quot;xss&quot;) &amp; test&lt;/script&gt;`);
  });

  it("Bun.deepEquals performs deep structural comparisons", () => {
    expect(Bun.deepEquals({ a: 1, b: [2, 3] }, { a: 1, b: [2, 3] })).toBe(true);
    expect(Bun.deepEquals({ a: 1, b: [2, 3] }, { a: 1, b: [2, 4] })).toBe(false);
  });

  it("Bun.sleep resolves after delay", async () => {
    const start = Date.now();
    await Bun.sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it("Bun.which finds executable in PATH", () => {
    const bunBin = Bun.which("bun");
    expect(typeof bunBin).toBe("string");
    expect(bunBin).toContain("bun");
  });

  it("bun:jsc provides heap stats and debugging snapshots", () => {
    const { heapStats, heapSize, memoryUsage, generateHeapSnapshotForDebugging } = require("bun:jsc");
    const stats = heapStats();
    expect(stats.heapSize).toBeGreaterThan(0);
    expect(stats.objectCount).toBeGreaterThan(0);
    expect(heapSize()).toBeGreaterThan(0);
    expect(memoryUsage().current).toBeGreaterThan(0);

    const snapshot = generateHeapSnapshotForDebugging();
    expect(typeof snapshot).toBe("object");
  });

  it("Bun.cron.parse parses cron schedule expressions", () => {
    if (Bun.cron && typeof Bun.cron.parse === "function") {
      const parsed = Bun.cron.parse("0 2 * * *");
      expect(parsed).toBeDefined();
    }
  });
});
