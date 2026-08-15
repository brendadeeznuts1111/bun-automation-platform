import { describe, expect, it } from "bun:test";
import { processScreenshot, serveScreenshot } from "../src/utils/image";

describe("Bun.Image processing", () => {
  function makeChunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(Bun.hash.crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  }

  function createTestPng(): Buffer {
    const width = 64;
    const height = 64;
    const rowSize = 1 + width * 4;
    const raw = new Uint8Array(rowSize * height);
    for (let y = 0; y < height; y++) {
      raw[y * rowSize] = 0;
      for (let x = 0; x < width; x++) {
        const offset = y * rowSize + 1 + x * 4;
        raw[offset] = 120;
        raw[offset + 1] = 150;
        raw[offset + 2] = 200;
        raw[offset + 3] = 255;
      }
    }

    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(width, 0);
    ihdrData.writeUInt32BE(height, 4);
    ihdrData[8] = 8;
    ihdrData[9] = 6;
    ihdrData[10] = 0;
    ihdrData[11] = 0;
    ihdrData[12] = 0;

    // JUSTIFIED: Uint8Array.buffer is ArrayBuffer-backed; Bun APIs expect ArrayBuffer
    const deflated = Buffer.from(Bun.deflateSync(raw.buffer as ArrayBuffer));
    const adler = Buffer.alloc(4);
    // JUSTIFIED: same — raw.buffer is the underlying ArrayBuffer
    adler.writeUInt32BE(Bun.hash.adler32(raw.buffer as ArrayBuffer), 0);
    const zlibStream = Buffer.concat([Buffer.from([0x78, 0x9c]), deflated, adler]);

    return Buffer.concat([
      signature,
      makeChunk("IHDR", ihdrData),
      makeChunk("IDAT", zlibStream),
      makeChunk("IEND", Buffer.alloc(0)),
    ]);
  }

  it("processes screenshot buffer into webp, thumb, and metadata", async () => {
    const png = createTestPng();
    const result = await processScreenshot(png, "test-img");

    expect(result.metadata.width).toBe(64);
    expect(result.metadata.height).toBe(64);
    expect(result.fullSize).toBeGreaterThan(0);
    expect(result.thumbSize).toBeGreaterThan(0);
    expect(result.dominantColor).toBe("#1f2020");
    expect(typeof result.placeholder).toBe("string");
  });

  it("serves screenshot response with correct format", async () => {
    const png = createTestPng();
    const result = await processScreenshot(png, "test-serve");

    const res = serveScreenshot(result.fullPath, 32, "webp");
    expect(res).toBeInstanceOf(Response);
  });
});
