/**
 * MIME type detection tests for Bun.file().
 *
 * XREF: Bug cross-reference chain — see docs/render-diagrams.ts#cross-reference-chain
 * This file covers Bug 41 (doc:2337)
 *
 * Verifies the `.type` property of BunFile (which extends Blob) returns
 * the correct MIME type based on file extension.
 *
 * Ref: https://bun.com/guides/read-file/mime
 * Ref: node_modules/bun-types/bun.d.ts#file (line 4100)
 *
 * Key findings:
 * - Text-based types include `;charset=utf-8` suffix
 * - Binary types have no charset suffix
 * - Extensions are CASE-SENSITIVE (.JSON → application/octet-stream)
 * - Unknown/no extensions return `application/octet-stream`
 * - Double extensions use the last one (.tar.gz → application/gzip)
 * - Bun.file() accepts a `type` option (BlobPropertyBag) to override
 * - File existence does NOT affect .type (purely extension-based)
 * - Some non-standard MIME types: .bmp → image/x-ms-bmp, .wav → audio/x-wav
 */

import { describe, expect, it } from "bun:test";

// Helper: check if a MIME type matches (ignoring charset suffix)
// JUSTIFIED: helper is used for ad-hoc verification, not in test cases below
function expectMimeType(path: string, expectedBase: string): string {
  const file = Bun.file(path);
  const type = file.type;
  const base = type.split(";")[0]!;
  expect(base).toBe(expectedBase);
  return type;
}

// Suppress unused warning — helper available for manual testing
void expectMimeType;

// ============================================================================
// Docs examples — exact verification
// ============================================================================

describe("Bun.file() MIME type — docs examples", () => {
  it("package.json → application/json;charset=utf-8", () => {
    const file = Bun.file("./package.json");
    expect(file.type).toBe("application/json;charset=utf-8");
  });

  it("index.html → text/html;charset=utf-8", () => {
    const file = Bun.file("./index.html");
    expect(file.type).toBe("text/html;charset=utf-8");
  });

  it("image.png → image/png", () => {
    const file = Bun.file("./image.png");
    expect(file.type).toBe("image/png");
  });
});

// ============================================================================
// Text types include ;charset=utf-8
// ============================================================================

describe("Bun.file() MIME type — text types with charset", () => {
  // These text types include ;charset=utf-8 suffix
  const textWithCharset: Array<[string, string]> = [
    ["file.json", "application/json"],
    ["file.html", "text/html"],
    ["file.css", "text/css"],
    ["file.ts", "text/javascript"],
    ["file.tsx", "text/javascript"],
    ["file.js", "text/javascript"],
    ["file.mjs", "text/javascript"],
    ["file.cjs", "text/javascript"],
    ["file.txt", "text/plain"],
    ["file.ini", "text/plain"],
    ["file.log", "text/plain"],
  ];

  it.each(textWithCharset)("%s → %s;charset=utf-8", (path, expectedBase) => {
    const file = Bun.file(path);
    expect(file.type).toBe(`${expectedBase};charset=utf-8`);
  });
});

describe("Bun.file() MIME type — text types without charset", () => {
  // These text types do NOT include ;charset=utf-8 suffix
  const textNoCharset: Array<[string, string]> = [
    ["file.csv", "text/csv"],
    ["file.md", "text/markdown"],
    ["file.markdown", "text/markdown"],
    ["file.xml", "application/xml"],
    ["file.yaml", "text/yaml"],
    ["file.yml", "text/yaml"],
    ["file.toml", "application/toml"],
    ["file.tsv", "text/tab-separated-values"],
    ["file.rtf", "text/rtf"],
    ["file.mdx", "text/mdx"],
  ];

  it.each(textNoCharset)("%s → %s (no charset)", (path, expected) => {
    const file = Bun.file(path);
    expect(file.type).toBe(expected);
  });
});

// ============================================================================
// Binary types do NOT have charset suffix
// ============================================================================

describe("Bun.file() MIME type — binary types no charset", () => {
  const binaryTypes: Array<[string, string]> = [
    ["file.png", "image/png"],
    ["file.jpg", "image/jpeg"],
    ["file.jpeg", "image/jpeg"],
    ["file.gif", "image/gif"],
    ["file.svg", "image/svg+xml"],
    ["file.webp", "image/webp"],
    ["file.ico", "image/x-icon"],
    ["file.avif", "image/avif"],
    ["file.heic", "image/heic"],
    ["file.mp3", "audio/mpeg"],
    ["file.mp4", "video/mp4"],
    ["file.webm", "video/webm"],
    ["file.ogg", "audio/ogg"],
    ["file.pdf", "application/pdf"],
    ["file.zip", "application/zip"],
    ["file.gz", "application/gzip"],
    ["file.tar", "application/x-tar"],
    ["file.wasm", "application/wasm"],
    ["file.woff", "font/woff"],
    ["file.woff2", "font/woff2"],
    ["file.ttf", "font/ttf"],
    ["file.otf", "font/otf"],
    ["file.7z", "application/x-7z-compressed"],
    ["file.rar", "application/x-rar-compressed"],
    ["file.bz2", "application/x-bzip2"],
    ["file.xz", "application/x-xz"],
  ];

  it.each(binaryTypes)("%s → %s (no charset)", (path, expected) => {
    const file = Bun.file(path);
    expect(file.type).toBe(expected);
  });
});

// ============================================================================
// Non-standard MIME types (Bun uses vendor-specific types)
// ============================================================================

describe("Bun.file() MIME type — non-standard vendor types", () => {
  it(".bmp → image/x-ms-bmp (not image/bmp)", () => {
    const file = Bun.file("./file.bmp");
    expect(file.type).toBe("image/x-ms-bmp");
    // IANA standard is image/bmp, but Bun uses the older x-ms-bmp variant
  });

  it(".wav → audio/x-wav (not audio/wav)", () => {
    const file = Bun.file("./file.wav");
    expect(file.type).toBe("audio/x-wav");
    // IANA standard is audio/wav, but Bun uses the older x-wav variant
  });

  it(".flac → audio/x-flac (not audio/flac)", () => {
    const file = Bun.file("./file.flac");
    expect(file.type).toBe("audio/x-flac");
  });

  it(".eot → application/vnd.ms-fontobject", () => {
    const file = Bun.file("./file.eot");
    expect(file.type).toBe("application/vnd.ms-fontobject");
  });

  it(".opus → audio/ogg (not audio/opus)", () => {
    const file = Bun.file("./file.opus");
    expect(file.type).toBe("audio/ogg");
  });

  it(".doc → application/msword", () => {
    const file = Bun.file("./file.doc");
    expect(file.type).toBe("application/msword");
  });

  it(".docx → application/vnd.openxmlformats...", () => {
    const file = Bun.file("./file.docx");
    expect(file.type).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it(".xls → application/vnd.ms-excel", () => {
    const file = Bun.file("./file.xls");
    expect(file.type).toBe("application/vnd.ms-excel");
  });

  it(".xlsx → application/vnd.openxmlformats...", () => {
    const file = Bun.file("./file.xlsx");
    expect(file.type).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  it(".ppt → application/vnd.ms-powerpoint", () => {
    const file = Bun.file("./file.ppt");
    expect(file.type).toBe("application/vnd.ms-powerpoint");
  });

  it(".pptx → application/vnd.openxmlformats...", () => {
    const file = Bun.file("./file.pptx");
    expect(file.type).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
  });
});

// ============================================================================
// Bug 41: Extensions are CASE-SENSITIVE
// ============================================================================

describe("Bug 41: file extensions are case-sensitive", () => {
  it(".JSON (uppercase) → application/octet-stream (not application/json)", () => {
    const file = Bun.file("./file.JSON");
    expect(file.type).toBe("application/octet-stream");
    // Most OSes and web servers treat extensions case-insensitively
    // Bun returns octet-stream for uppercase extensions
  });

  it(".Html (mixed case) → application/octet-stream", () => {
    const file = Bun.file("./file.Html");
    expect(file.type).toBe("application/octet-stream");
  });

  it(".PNG (uppercase) → application/octet-stream", () => {
    const file = Bun.file("./file.PNG");
    expect(file.type).toBe("application/octet-stream");
  });

  it(".JS (uppercase) → application/octet-stream", () => {
    const file = Bun.file("./file.JS");
    expect(file.type).toBe("application/octet-stream");
  });

  it(".CSS (uppercase) → application/octet-stream", () => {
    const file = Bun.file("./file.CSS");
    expect(file.type).toBe("application/octet-stream");
  });

  it(".MD (uppercase) → application/octet-stream", () => {
    const file = Bun.file("./file.MD");
    expect(file.type).toBe("application/octet-stream");
  });
});

// ============================================================================
// Unknown and no extensions → application/octet-stream
// ============================================================================

describe("Bun.file() MIME type — unknown/no extension", () => {
  it("unknown extension → application/octet-stream", () => {
    const file = Bun.file("./file.unknownext");
    expect(file.type).toBe("application/octet-stream");
  });

  it("no extension → application/octet-stream", () => {
    const file = Bun.file("./file");
    expect(file.type).toBe("application/octet-stream");
  });

  it(".zstd → application/octet-stream (not recognized)", () => {
    const file = Bun.file("./file.zstd");
    expect(file.type).toBe("application/octet-stream");
  });

  it(".zst → application/octet-stream (not recognized)", () => {
    const file = Bun.file("./file.zst");
    expect(file.type).toBe("application/octet-stream");
  });

  it(".jsonc → application/octet-stream (not recognized)", () => {
    const file = Bun.file("./file.jsonc");
    expect(file.type).toBe("application/octet-stream");
  });

  it(".env → application/octet-stream (not recognized)", () => {
    const file = Bun.file("./file.env");
    expect(file.type).toBe("application/octet-stream");
  });

  it(".lock → application/octet-stream (not recognized)", () => {
    const file = Bun.file("./file.lock");
    expect(file.type).toBe("application/octet-stream");
  });
});

// ============================================================================
// Double extensions — last extension wins
// ============================================================================

describe("Bun.file() MIME type — double extensions", () => {
  it(".tar.gz → application/gzip (last ext wins)", () => {
    const file = Bun.file("./file.tar.gz");
    expect(file.type).toBe("application/gzip");
  });

  it(".min.js → text/javascript;charset=utf-8 (last ext wins)", () => {
    const file = Bun.file("./file.min.js");
    expect(file.type).toBe("text/javascript;charset=utf-8");
  });

  it(".d.ts → text/javascript;charset=utf-8 (last ext wins)", () => {
    const file = Bun.file("./file.d.ts");
    expect(file.type).toBe("text/javascript;charset=utf-8");
  });

  it(".test.ts → text/javascript;charset=utf-8 (last ext wins)", () => {
    const file = Bun.file("./file.test.ts");
    expect(file.type).toBe("text/javascript;charset=utf-8");
  });

  it(".spec.ts → text/javascript;charset=utf-8 (last ext wins)", () => {
    const file = Bun.file("./file.spec.ts");
    expect(file.type).toBe("text/javascript;charset=utf-8");
  });
});

// ============================================================================
// Bun.file() accepts type option to override MIME
// ============================================================================

describe("Bun.file() MIME type — type option override", () => {
  it("can override with type option", () => {
    const file = Bun.file("./package.json", { type: "text/plain" });
    expect(file.type).toBe("text/plain;charset=utf-8");
  });

  it("can override with custom MIME type", () => {
    const file = Bun.file("./file.json", { type: "application/custom" });
    expect(file.type).toBe("application/custom");
  });

  it("can override binary file with text type", () => {
    const file = Bun.file("./file.png", { type: "text/plain" });
    expect(file.type).toBe("text/plain;charset=utf-8");
  });

  it("empty type option falls back to extension detection", () => {
    const file = Bun.file("./file.json", { type: "" });
    // Empty type doesn't override — falls back to extension-based MIME
    expect(file.type).toBe("application/json;charset=utf-8");
  });
});

// ============================================================================
// File existence does NOT affect .type
// ============================================================================

describe("Bun.file() MIME type — existence independence", () => {
  it("non-existent .json file still has json MIME type", () => {
    const existing = Bun.file("./package.json");
    const nonExistent = Bun.file("./does-not-exist-12345.json");
    expect(existing.type).toBe(nonExistent.type);
    expect(nonExistent.type).toBe("application/json;charset=utf-8");
  });

  it("non-existent .png file still has png MIME type", () => {
    const nonExistent = Bun.file("./does-not-exist-12345.png");
    expect(nonExistent.type).toBe("image/png");
  });
});

// ============================================================================
// .type is inherited from Blob (prototype, not own property)
// ============================================================================

describe("Bun.file() MIME type — Blob inheritance", () => {
  it(".type is on the prototype (Blob), not own property", () => {
    const file = Bun.file("./package.json");
    expect("type" in file).toBe(true);
    expect(file.hasOwnProperty("type")).toBe(false);
  });

  it("BunFile extends Blob", () => {
    const file = Bun.file("./package.json");
    expect(file).toBeInstanceOf(Blob);
  });

  it("Blob.type works the same way", () => {
    const blob = new Blob(["test"], { type: "text/plain" });
    expect(blob.type).toBe("text/plain;charset=utf-8");
  });
});

// ============================================================================
// URL paths
// ============================================================================

describe("Bun.file() MIME type — URL paths", () => {
  it("accepts URL object", () => {
    const url = new URL("file:///path/to/file.json");
    const file = Bun.file(url);
    expect(file.type).toBe("application/json;charset=utf-8");
  });

  it("accepts file:// URL string", () => {
    const file = Bun.file("file:///path/to/file.html");
    expect(file.type).toBe("text/html;charset=utf-8");
  });
});

// ============================================================================
// Source map and special types
// ============================================================================

describe("Bun.file() MIME type — special types", () => {
  it(".map → application/json;charset=utf-8", () => {
    const file = Bun.file("./file.map");
    expect(file.type).toBe("application/json;charset=utf-8");
  });

  it(".json5 → application/json5", () => {
    const file = Bun.file("./file.json5");
    expect(file.type).toBe("application/json5");
  });

  it(".markdown → text/markdown", () => {
    const file = Bun.file("./file.markdown");
    expect(file.type).toBe("text/markdown");
  });
});

// ============================================================================
// Property-based: MIME type is deterministic
// ============================================================================

describe("Bun.file() MIME type — determinism", () => {
  const paths = ["./file.json", "./file.png", "./file.ts", "./file.html", "./file.unknown"];

  it.each(paths)("MIME type is deterministic for %s", (path: string) => {
    const f1 = Bun.file(path);
    const f2 = Bun.file(path);
    expect(f1.type).toBe(f2.type);
  });
});
