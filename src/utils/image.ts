/**
 * Screenshot processing — uses Bun.Image for zero-dependency image manipulation.
 *
 * Provides:
 * - Resize screenshots for thumbnails
 * - Convert to WebP for efficient storage
 * - Generate ThumbHash placeholders for blur-up loading
 * - Extract dominant color for placeholder backgrounds
 * - Extract metadata (dimensions, format)
 *
 * All processing runs off the main thread (except metadata()).
 */

import { resolve, join } from "node:path";
import { mkdirSync, realpathSync } from "node:fs";

const SCREENSHOT_DIR = resolve(process.env.SCREENSHOT_DIR ?? "./data/screenshots");
const THUMBNAIL_WIDTH = parseInt(process.env.THUMBNAIL_WIDTH ?? "400", 10);
const THUMBNAIL_QUALITY = parseInt(process.env.THUMBNAIL_QUALITY ?? "85", 10);
const FULL_QUALITY = parseInt(process.env.SCREENSHOT_QUALITY ?? "90", 10);

export interface ScreenshotResult {
  /** Path to the full-size WebP screenshot. */
  fullPath: string;
  /** Path to the thumbnail WebP. */
  thumbPath: string;
  /** ThumbHash data URL for blur-up placeholder. */
  placeholder: string;
  /** Image metadata. */
  metadata: {
    width: number;
    height: number;
    format: import("bun").Image.Format;
  };
  /** Dominant color (hex) for placeholder background. */
  dominantColor: string;
  /** File size in bytes of the full screenshot. */
  fullSize: number;
  /** File size in bytes of the thumbnail. */
  thumbSize: number;
}

/**
 * Process a raw screenshot (PNG/JPEG buffer or file path) into:
 * 1. A full-size WebP at configured quality
 * 2. A thumbnail WebP at THUMBNAIL_WIDTH
 * 3. A ThumbHash placeholder data URL
 * 4. Metadata (dimensions, format)
 * 5. Dominant color for CSS placeholder backgrounds
 *
 * @param input - Path string, ArrayBuffer, TypedArray, Blob, BunFile, or data: URL
 * @param name - Base filename (without extension) for the output files
 * @returns ScreenshotResult with paths and metadata
 */
export async function processScreenshot(
  input: string | ArrayBuffer | Uint8Array | Blob | import("bun").BunFile,
  name: string,
): Promise<ScreenshotResult> {
  // Ensure screenshot directory exists
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const fullPath = join(SCREENSHOT_DIR, `${name}.webp`);
  const thumbPath = join(SCREENSHOT_DIR, `${name}_thumb.webp`);

  // L1: All 5 operations in parallel — each gets its own Bun.Image instance.
  // K1: Transform methods (.resize(), .webp()) return `this` and mutate the
  // same instance, so parallel branches MUST use separate instances.
  // Ref: https://bun.sh/blog/bun-v1.3.14#chainable-transforms
  //
  // Terminals run off the main thread (except metadata() which is ~0.004ms).
  // Ref: https://bun.sh/blog/bun-v1.3.14#terminal-methods
  //
  // K2: Thumbnail uses mks2013 filter — optimized for downscaling quality.
  // Ref: https://bun.sh/blog/bun-v1.3.14#resize-filters
  //
  // The Image constructor is synchronous and lazy (read happens when a
  // terminal is awaited), so creating 5 instances is cheap. For ArrayBuffer
  // inputs, the blog confirms "zero-copy ArrayBuffer borrowing".
  // Ref: https://bun.sh/blog/bun-v1.3.14#input-sources
  //
  // M2: .write() returns Promise<number> (bytes written) — use that directly
  // instead of calling Bun.file().size after (avoids 2 extra stat calls).
  // Ref: node_modules/bun-types/bun.d.ts — write(dest): Promise<number>
  const [fullSize, thumbSize, placeholder, meta, dominantColor] = await Promise.all([
    // Full-size WebP — write() returns bytes written
    new Bun.Image(input, { maxPixels: 4096 * 4096 })
      .webp({ quality: FULL_QUALITY })
      .write(fullPath),
    // Thumbnail (resize + WebP) — mks2013 filter for downscaling
    new Bun.Image(input, { maxPixels: 4096 * 4096 })
      .resize(THUMBNAIL_WIDTH, THUMBNAIL_WIDTH, {
        fit: "inside",
        withoutEnlargement: true,
        filter: "mks2013",
      })
      .webp({ quality: THUMBNAIL_QUALITY })
      .write(thumbPath),
    // ThumbHash placeholder for blur-up loading
    new Bun.Image(input, { maxPixels: 4096 * 4096 }).placeholder(),
    // Metadata (runs on main thread, ~0.004ms — negligible)
    new Bun.Image(input, { maxPixels: 4096 * 4096 }).metadata(),
    // Dominant color (1x1 resize → PNG → parse IDAT)
    extractDominantColor(input),
  ]);

  return {
    fullPath,
    thumbPath,
    placeholder,
    metadata: meta,
    dominantColor,
    fullSize,
    thumbSize,
  };
}

/**
 * Extract the dominant/average color from an image as a hex string.
 *
 * Resizes the image to 1x1 (which averages all pixels), encodes as PNG,
 * then parses the PNG IDAT chunk(s) to read the single pixel's RGB values.
 *
 * Bun.Image encodes 1x1 PNG as RGBA (color type 6):
 *   - IHDR: width=1, height=1, bit depth=8, color type=6 (RGBA)
 *   - IDAT: zlib-compressed [filter_byte(0), R, G, B, A] = 5 bytes
 *   - IEND: empty
 *
 * PNG allows splitting the compressed data across multiple IDAT chunks
 * (though for 5 bytes it never will). We concatenate all IDAT chunks
 * before inflating, per the PNG spec.
 *
 * Ref: https://bun.sh/blog/bun-v1.3.14#terminal-methods
 *   ".bytes()" returns the encoded image as a Uint8Array
 */
async function extractDominantColor(
  input: string | ArrayBuffer | Uint8Array | Blob | import("bun").BunFile,
): Promise<string> {
  try {
    // Resize to 1x1 — this averages all pixels into a single color.
    // Encode as PNG (lossless, simple to parse) and get the raw bytes.
    const pngBytes = await new Bun.Image(input, { maxPixels: 4096 * 4096 })
      .resize(1, 1, { fit: "fill" })
      .png()
      .bytes();

    // Parse the PNG to find all IDAT chunks.
    // PNG structure: 8-byte signature, then chunks of [length(4), type(4), data(length), crc(4)]
    const view = new DataView(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
    let offset = 8; // skip PNG signature
    const idatChunks: Uint8Array[] = [];
    while (offset < pngBytes.length) {
      const chunkLen = view.getUint32(offset);
      const chunkType = String.fromCharCode(
        pngBytes[offset + 4]!,
        pngBytes[offset + 5]!,
        pngBytes[offset + 6]!,
        pngBytes[offset + 7]!,
      );
      offset += 8;

      if (chunkType === "IDAT") {
        idatChunks.push(pngBytes.subarray(offset, offset + chunkLen));
      }

      offset += chunkLen + 4; // skip data + CRC
    }

    if (idatChunks.length === 0) {
      return "#1f2020"; // no IDAT — malformed PNG
    }

    // Concatenate all IDAT chunks (PNG spec allows multiple)
    // JUSTIFIED: new Uint8Array() returns Uint8Array<ArrayBuffer> but TS
    // infers Uint8Array<ArrayBufferLike> in the ternary. The buffer is
    // always a real ArrayBuffer from `new Uint8Array(n)`.
    const idat: Uint8Array = idatChunks.length === 1
      ? idatChunks[0]!
      : new Uint8Array(idatChunks.reduce((sum, chunk) => sum + chunk.length, 0));

    if (idatChunks.length > 1) {
      let pos = 0;
      for (const chunk of idatChunks) {
        idat.set(chunk, pos);
        pos += chunk.length;
      }
    }

    // PNG IDAT contains zlib-wrapped deflate data (2-byte header +
    // deflate data + 4-byte adler32 checksum). Bun.inflateSync expects
    // raw deflate (no zlib wrapper), so we strip the 2-byte header and
    // 4-byte trailer. Use DecompressionStream as a fallback for robustness.
    const rawDeflate = idat.subarray(2, idat.length - 4);
    let raw: Uint8Array;
    try {
      // JUSTIFIED: ArrayBufferLike → ArrayBuffer for Bun.inflateSync
      raw = Bun.inflateSync(rawDeflate as Uint8Array<ArrayBuffer>);
    } catch {
      // Fallback: use DecompressionStream which handles zlib format
      const ds = new DecompressionStream("deflate");
      // JUSTIFIED: ArrayBufferLike → ArrayBuffer for BlobPart (DOM lib + bun-types)
      const stream = new Blob([idat as Uint8Array<ArrayBuffer>]).stream().pipeThrough(ds);
      const buf = await new Response(stream).arrayBuffer();
      raw = new Uint8Array(buf);
    }
    // Bun.Image encodes as RGBA: raw = [filter_byte(0), R, G, B, A]
    const r = raw[1] ?? 0;
    const g = raw[2] ?? 0;
    const b = raw[3] ?? 0;
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  } catch {
    // Fall back to default if parsing fails
  }
  return "#1f2020"; // default dark background
}

/**
 * Stream a screenshot as a response body.
 * Useful for serving screenshots via HTTP.
 *
 * Validates that the path resolves within the screenshot directory to
 * prevent path traversal attacks (e.g. "../../etc/passwd").
 */
export async function serveScreenshot(
  path: string,
  width?: number,
  format: "webp" | "jpeg" | "png" = "webp",
): Promise<Response> {
  // Resolve and verify the path is within the screenshot directory
  const resolved = resolve(path);
  if (!resolved.startsWith(SCREENSHOT_DIR + "/") && resolved !== SCREENSHOT_DIR) {
    return new Response("forbidden", { status: 403 });
  }

  // E9: Use realpath to resolve symlinks — prevents an attacker from creating
  // a symlink inside SCREENSHOT_DIR that points to a file outside it.
  // L4: realpathSync(SCREENSHOT_DIR) can throw if the directory doesn't exist
  // (e.g. no screenshots have been processed yet). Return 404 in that case.
  let realPath: string;
  try {
    realPath = realpathSync(resolved);
  } catch {
    return new Response("file not found", { status: 404 });
  }
  let realScreenshotDir: string;
  try {
    realScreenshotDir = realpathSync(SCREENSHOT_DIR);
  } catch {
    return new Response("file not found", { status: 404 });
  }
  if (!realPath.startsWith(realScreenshotDir + "/") && realPath !== realScreenshotDir) {
    return new Response("forbidden", { status: 403 });
  }

  let img = new Bun.Image(realPath, { maxPixels: 4096 * 4096 });
  if (width) img = img.resize(width, width, { fit: "inside" });

  // Bun.Image instances work directly as Response bodies with automatic
  // Content-Type. Ref: https://bun.sh/blog/bun-v1.3.14#body-integration
  //   return new Response(new Bun.Image(upload).resize(200).jpeg());
  switch (format) {
    case "jpeg":
      // JUSTIFIED: Bun.Image is a documented Response body; DOM BodyInit omits it
      return new Response(img.jpeg() as unknown as BodyInit);
    case "png":
      // JUSTIFIED: Bun.Image is a documented Response body; DOM BodyInit omits it
      return new Response(img.png() as unknown as BodyInit);
    case "webp":
    default:
      // JUSTIFIED: Bun.Image is a documented Response body; DOM BodyInit omits it
      return new Response(img.webp({ quality: FULL_QUALITY }) as unknown as BodyInit);
  }
}

/**
 * Generate a screenshot from a Bun.Image input and return as base64.
 * Used by the live control WebSocket to stream screenshots to the dashboard.
 */
export async function screenshotToBase64(
  input: string | ArrayBuffer | Uint8Array | Blob | import("bun").BunFile,
  maxWidth = 1280,
  quality = 70,
): Promise<string> {
  return new Bun.Image(input, { maxPixels: 4096 * 4096 }).resize(maxWidth, maxWidth, { fit: "inside" }).jpeg({ quality }).toBase64();
}
