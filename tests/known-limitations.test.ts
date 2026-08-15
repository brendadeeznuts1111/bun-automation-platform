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
    // Use the existing test screenshot from the image test.
    // The stub returns "#1f2020" regardless of input — a real
    // implementation would return a color derived from the image.
    const result = await processScreenshot(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      "test-failing-color",
    );
    expect(result.dominantColor).not.toBe("#1f2020");
  });
});
