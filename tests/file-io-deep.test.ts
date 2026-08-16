/**
 * Deep audit: Bun.file / Bun.write edge cases — Bugs 35-36.
 *
 * XREF: Bug cross-reference chain — see docs/render-diagrams.ts#cross-reference-chain
 * This file covers Bug 35 (doc:2331), 36 (doc:2333)
 *
 * Verifies:
 * - Bug 35: Bun.write with object writes [object Object] (not JSON)
 * - Bug 36: Bun.write with ReadableStream writes [object ReadableStream]
 *   (not consumed)
 * - Bun.file properties (size, type, name, lastModified)
 * - Read methods (text, json, arrayBuffer, stream)
 * - Write various types (number, boolean, Buffer, Response)
 * - Bun.write returns number (bytes written), not BunFile
 * - file.writer() for streaming writes
 * - file.slice() returns Blob
 * - createPath option auto-creates directories
 * - Large file (1MB) read/write
 * - Empty file handling
 *
 * Ref: https://bun.com/docs/runtime/file
 * Ref: https://bun.com/docs/runtime/write
 */

import { describe, expect, it } from "bun:test";

const tmp = "/tmp/deep-audit-test";

describe("Bun.file properties", () => {
  it("size is 0 for non-existent file", () => {
    const f = Bun.file("/tmp/nonexistent-file-xyz123.txt");
    expect(f.size).toBe(0);
  });

  it("type defaults to text/plain;charset=utf-8", () => {
    const f = Bun.file("/tmp/test.txt");
    expect(f.type).toContain("text/plain");
  });

  it("name returns the file path", () => {
    const f = Bun.file("/tmp/test.txt");
    expect(f.name).toBe("/tmp/test.txt");
  });

  it("lastModified returns a number", () => {
    const f = Bun.file("/tmp/test.txt");
    expect(typeof f.lastModified).toBe("number");
  });

  it("exists() returns false for non-existent file", async () => {
    const f = Bun.file("/tmp/nonexistent-file-xyz123.txt");
    expect(await f.exists()).toBe(false);
  });
});

describe("Bun.write with various types", () => {
  it("writes string", async () => {
    await Bun.write(`${tmp}/str.txt`, "hello");
    expect(await Bun.file(`${tmp}/str.txt`).text()).toBe("hello");
  });

  it("writes number (converted to string)", async () => {
    // JUSTIFIED: bun-types write() input is BunFile, but runtime accepts number
    await Bun.write(`${tmp}/num.txt`, 42 as never);
    expect(await Bun.file(`${tmp}/num.txt`).text()).toBe("42");
  });

  it("writes boolean (converted to string)", async () => {
    // JUSTIFIED: bun-types write() input is BunFile, but runtime accepts boolean
    await Bun.write(`${tmp}/bool.txt`, true as never);
    expect(await Bun.file(`${tmp}/bool.txt`).text()).toBe("true");
  });

  it("writes Uint8Array", async () => {
    await Bun.write(`${tmp}/buf.txt`, new TextEncoder().encode("buffer data"));
    expect(await Bun.file(`${tmp}/buf.txt`).text()).toBe("buffer data");
  });

  it("writes Response object", async () => {
    await Bun.write(`${tmp}/resp.txt`, new Response("response body"));
    expect(await Bun.file(`${tmp}/resp.txt`).text()).toBe("response body");
  });

  it("writes BigInt (converted to string)", async () => {
    // JUSTIFIED: bun-types doesn't accept BigInt for write input, but runtime does
    await Bun.write(`${tmp}/bigint.txt`, 123n as never);
    expect(await Bun.file(`${tmp}/bigint.txt`).text()).toBe("123");
  });

  it("null throws 'expects a Blob-y thing'", async () => {
    // JUSTIFIED: testing runtime error behavior with invalid input
    expect(() => Bun.write(`${tmp}/null.txt`, null as never)).toThrow();
  });

  it("undefined throws 'expects a Blob-y thing'", async () => {
    // JUSTIFIED: testing runtime error behavior with invalid input
    expect(() => Bun.write(`${tmp}/undef.txt`, undefined as never)).toThrow();
  });
});

describe("Bun.write return value", () => {
  it("returns number (bytes written), not BunFile", async () => {
    const result = await Bun.write(`${tmp}/return.txt`, "data");
    expect(typeof result).toBe("number");
    expect(result).toBe(4);
  });
});

describe("Bug 35: Bun.write with object writes [object Object]", () => {
  it("object is NOT JSON stringified — writes [object Object]", async () => {
    // JUSTIFIED: bun-types write() input is BunFile, but runtime accepts object
    await Bun.write(`${tmp}/obj.txt`, { a: 1, b: 2 } as never);
    const content = await Bun.file(`${tmp}/obj.txt`).text();
    // Bug: Object is stringified as [object Object] instead of JSON
    expect(content).toBe("[object Object]");
  });
});

describe("Bug 36: Bun.write with ReadableStream writes [object ReadableStream]", () => {
  it("ReadableStream is NOT consumed — writes literal toString", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue("chunk1-");
        controller.enqueue("chunk2-");
        controller.enqueue("chunk3");
        controller.close();
      },
    });
    // JUSTIFIED: bun-types write() input is BunFile, but runtime accepts ReadableStream
    await Bun.write(`${tmp}/stream.txt`, stream as never);
    const content = await Bun.file(`${tmp}/stream.txt`).text();
    // Bug: Stream is not consumed, written as [object ReadableStream]
    expect(content).toContain("[object ReadableStream]");
  });
});

describe("file.writer() for streaming writes", () => {
  it("write/flush/end work correctly", async () => {
    const w = Bun.file(`${tmp}/writer.txt`).writer();
    expect(w.write("chunk1-")).toBe(7);
    expect(w.write("chunk2-")).toBe(7);
    expect(w.write("chunk3")).toBe(6);
    // end() flushes remaining buffer and returns total bytes written
    expect(w.end()).toBe(20);
    expect(await Bun.file(`${tmp}/writer.txt`).text()).toBe("chunk1-chunk2-chunk3");
  });

  it("flush() forces write to disk", async () => {
    const w = Bun.file(`${tmp}/writer2.txt`).writer();
    w.write("data1");
    w.flush();
    w.write("data2");
    w.end();
    expect(await Bun.file(`${tmp}/writer2.txt`).text()).toBe("data1data2");
  });
});

describe("file.slice()", () => {
  it("returns Blob with sliced content", async () => {
    await Bun.write(`${tmp}/slice.txt`, "0123456789");
    const f = Bun.file(`${tmp}/slice.txt`);
    const sliced = f.slice(2, 5);
    expect(sliced instanceof Blob).toBe(true);
    expect(await sliced.text()).toBe("234");
  });
});

describe("createPath option", () => {
  it("auto-creates nested directories", async () => {
    await Bun.write(`${tmp}/newdir/file.txt`, "test", { createPath: true });
    expect(await Bun.file(`${tmp}/newdir/file.txt`).text()).toBe("test");
  });
});

describe("large file handling", () => {
  it("1MB file writes and reads correctly", async () => {
    const large = "x".repeat(1024 * 1024);
    await Bun.write(`${tmp}/large.txt`, large);
    const f = Bun.file(`${tmp}/large.txt`);
    expect(f.size).toBe(1048576);
    expect(await f.text()).toBe(large);
  });
});

describe("empty file", () => {
  it("size is 0 and text is empty string", async () => {
    await Bun.write(`${tmp}/empty.txt`, "");
    const f = Bun.file(`${tmp}/empty.txt`);
    expect(f.size).toBe(0);
    expect(await f.text()).toBe("");
  });
});

describe("read methods", () => {
  it("json() parses JSON content", async () => {
    await Bun.write(`${tmp}/test.json`, '{"a":1,"b":2}');
    const f = Bun.file(`${tmp}/test.json`);
    const json = await f.json();
    expect(json.a).toBe(1);
    expect(json.b).toBe(2);
  });

  it("arrayBuffer() returns ArrayBuffer", async () => {
    await Bun.write(`${tmp}/ab.txt`, "hello");
    const f = Bun.file(`${tmp}/ab.txt`);
    const ab = await f.arrayBuffer();
    expect(ab.byteLength).toBe(5);
  });

  it("stream() returns ReadableStream", async () => {
    await Bun.write(`${tmp}/stream-source.txt`, "data");
    const f = Bun.file(`${tmp}/stream-source.txt`);
    const stream = f.stream();
    expect(stream instanceof ReadableStream).toBe(true);
  });
});

describe("directory handling", () => {
  it("Bun.file on directory has size > 0 but text() throws", async () => {
    const f = Bun.file("/tmp");
    expect(f.size).toBeGreaterThan(0);
    expect(f.text()).rejects.toThrow();
  });
});
