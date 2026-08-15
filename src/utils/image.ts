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
    format: string;
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

  // Guard against decompression bombs: screenshots are at most 16384x16384
  // (Bun.WebView max viewport), but we cap at 4096x4096 (~16MP) which is
  // more than enough for any realistic screenshot.
  const img = new Bun.Image(input, { maxPixels: 4096 * 4096 });

  // Extract metadata (runs on main thread, very fast — 0.004ms)
  const meta = await img.metadata();

  // M1: Parallelize the three independent encode terminals.
  // Each terminal triggers a separate decode→transform→encode pipeline,
  // but running them concurrently overlaps the off-thread work.
  const fullPath = join(SCREENSHOT_DIR, `${name}.webp`);
  const thumbPath = join(SCREENSHOT_DIR, `${name}_thumb.webp`);

  const [, , placeholder] = await Promise.all([
    // Full-size WebP
    img.webp({ quality: FULL_QUALITY }).write(fullPath),
    // Thumbnail (resize + WebP)
    img
      .resize(THUMBNAIL_WIDTH, THUMBNAIL_WIDTH, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: THUMBNAIL_QUALITY })
      .write(thumbPath),
    // ThumbHash placeholder for blur-up loading
    img.placeholder(),
  ]);

  const fullSize = Bun.file(fullPath).size;
  const thumbSize = Bun.file(thumbPath).size;

  // Extract dominant color from a tiny version for CSS background
  const dominantColor = await extractDominantColor(img);

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
 * Extract the dominant color from an image as a hex string.
 *
 * Bun.Image doesn't expose per-pixel access, so we resize to 1x1 and
 * encode as JPEG base64. The JPEG base64 is not directly parseable for
 * pixel values without a decoder, so for now we return a default dark
 * background color. The ThumbHash placeholder (generated separately)
 * already encodes the dominant color for blur-up loading.
 *
 * TODO: When Bun.Image adds a pixel accessor, parse the 1x1 buffer directly.
 */
async function extractDominantColor(_img: import("bun").Image): Promise<string> {
  return "#1f2020"; // default dark background — thumbhash carries the real color
}

/**
 * Stream a screenshot as a response body.
 * Useful for serving screenshots via HTTP.
 *
 * Validates that the path resolves within the screenshot directory to
 * prevent path traversal attacks (e.g. "../../etc/passwd").
 */
export function serveScreenshot(
  path: string,
  width?: number,
  format: "webp" | "jpeg" | "png" = "webp",
): Response {
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
