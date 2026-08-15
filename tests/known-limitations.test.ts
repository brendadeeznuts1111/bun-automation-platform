/**
 * Known limitations tracked as failing tests.
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
  // extractDominantColor in src/utils/image.ts is a stub that always
  // returns "#1f2020" — it doesn't actually extract color from the image.
  // When Bun.Image adds a pixel accessor, this test will start passing
  // and Bun will alert us to remove the .failing mark.
  it.failing("extractDominantColor returns the real dominant color (not the stub)", async () => {
    // Minimal valid 1x1 red PNG (RGBA). The stub returns "#1f2020"
    // regardless of input — a real implementation would return a color
    // derived from the image pixels (close to red for this input).
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
