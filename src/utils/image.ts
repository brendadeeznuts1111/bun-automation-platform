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

  // K1: Bun.Image transform methods (.resize(), .webp(), etc.) return `this`
  // and mutate the same instance. Using a single Image for parallel pipelines
  // causes a race condition — the second .resize()/.webp() overwrites the
  // first branch's state. Each parallel branch needs its own Image instance.
  // Ref: https://bun.sh/blog/bun-v1.3.14#chainable-transforms
  //   ".resize(w, h?, {filter, fit, withoutEnlargement})" returns this

  // Extract metadata first (runs on main thread, very fast — 0.004ms per
  // the v1.3.14 benchmark). The Image instance is cheap to construct —
  // the underlying read happens lazily when a terminal is awaited.
  // Ref: https://bun.sh/blog/bun-v1.3.14#terminal-methods
  const metaImg = new Bun.Image(input, { maxPixels: 4096 * 4096 });
  const meta = await metaImg.metadata();

  const fullPath = join(SCREENSHOT_DIR, `${name}.webp`);
  const thumbPath = join(SCREENSHOT_DIR, `${name}_thumb.webp`);

  // M1: Parallelize the three independent encode terminals.
  // K1: Each branch gets its own Bun.Image instance to avoid the race.
  // K2: Thumbnail uses mks2013 filter — optimized for downscaling quality.
  // Ref: https://bun.sh/blog/bun-v1.3.14#resize-filters
  //   "plus mks2013 and mks2021" — MKS filters for high-quality thumbnails
  const [, , placeholder] = await Promise.all([
    // Full-size WebP
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
  ]);

  const fullSize = Bun.file(fullPath).size;
  const thumbSize = Bun.file(thumbPath).size;

  // Extract dominant color from a 1x1 resize for CSS background
  const dominantColor = await extractDominantColor(input);

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
 * then parses the PNG IDAT chunk to read the single pixel's RGB values.
 *
 * The PNG format for a 1x1 RGB image is straightforward:
 *   - IHDR: width=1, height=1, bit depth=8, color type=2 (RGB)
 *   - IDAT: deflate-compressed [filter_byte, R, G, B]
 *   - IEND: empty
 *
 * We inflate the IDAT data and read bytes 1-3 (skip filter byte 0).
 *
 * Ref: https://bun.sh/blog/bun-v1.3.14#terminal-methods
 *   ".buffer()" returns the encoded image as an ArrayBuffer
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

    // Parse the PNG to find the IDAT chunk.
    // PNG structure: 8-byte signature, then chunks of [length(4), type(4), data(length), crc(4)]
    const view = new DataView(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
    let offset = 8; // skip PNG signature
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
        // PNG IDAT contains zlib-wrapped deflate data (2-byte header + 
        // deflate data + 4-byte adler32 checksum). Bun.inflateSync expects
        // raw deflate (no zlib wrapper), so we strip the 2-byte header and
        // 4-byte trailer. Use DecompressionStream as a fallback for robustness.
        const idat = pngBytes.subarray(offset, offset + chunkLen);
        const rawDeflate = idat.subarray(2, idat.length - 4);
        let raw: Uint8Array;
        try {
          // Bun.inflateSync requires Uint8Array<ArrayBuffer> but .subarray()
          // returns Uint8Array<ArrayBufferLike>. The underlying buffer is
          // always a real ArrayBuffer (from .bytes() terminal).
          // JUSTIFIED: ArrayBufferLike → ArrayBuffer for Bun.inflateSync
          raw = Bun.inflateSync(rawDeflate as Uint8Array<ArrayBuffer>);
        } catch {
          // Fallback: use DecompressionStream which handles zlib format
          const ds = new DecompressionStream("deflate");
          const stream = new Blob([idat]).stream().pipeThrough(ds);
          const buf = await new Response(stream).arrayBuffer();
          raw = new Uint8Array(buf);
        }
        // For a 1x1 RGB PNG: raw = [filter_byte(0), R, G, B]
        // For a 1x1 RGBA PNG: raw = [filter_byte(0), R, G, B, A]
        const r = raw[1] ?? 0;
        const g = raw[2] ?? 0;
        const b = raw[3] ?? 0;
        return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
      }

      offset += chunkLen + 4; // skip data + CRC
    }
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
  let realPath: string;
  try {
    realPath = realpathSync(resolved);
  } catch {
    return new Response("file not found", { status: 404 });
  }
  const realScreenshotDir = realpathSync(SCREENSHOT_DIR);
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
      return new Response(img.jpeg());
    case "png":
      return new Response(img.png());
    case "webp":
    default:
      return new Response(img.webp({ quality: FULL_QUALITY }));
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
