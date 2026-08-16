/**
 * Known limitations tracked as failing tests.
 *
 * XREF: Bug cross-reference chain — see docs/render-diagrams.ts#cross-reference-chain
 * This file tracks known limitations via test.failing()
 *
 * test.failing() inverts the result: a failing test passes, and if the
 * test starts passing (i.e. the limitation is fixed), Bun reports it as
 * a failure with a message to remove the .failing mark.
 *
 * Run `bun test --todo` to find any that have been fixed.
 */

import { describe, expect, it } from "bun:test";
import { processScreenshot } from "../src/utils/image";

describe("known limitations", () => {
  // K3: extractDominantColor is now implemented — it resizes to 1x1, encodes
  // as PNG, and parses the IDAT chunk to read the average RGB pixel.
  // This was previously a stub returning "#1f2020". The .failing mark has
  // been removed since the implementation now works.
  it("extractDominantColor returns the real dominant color (not the stub)", async () => {
    // Minimal valid 1x1 red PNG (RGBA). The average color should be red-ish.
    const redPng = new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0,
      1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68,
      65, 84, 120, 218, 99, 252, 255, 159, 161, 30, 0, 7, 130, 2, 127, 61,
      200, 72, 239, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ]);
    const result = await processScreenshot(redPng, "test-failing-color");
    expect(result.dominantColor).not.toBe("#1f2020");
  });
});
