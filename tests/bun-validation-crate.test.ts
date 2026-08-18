/**
 * Workspace crate + bun create / bun init integration.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAll, CLI_VERSION, normalizeVersion } from "bun-validation";

const crateDir = join(import.meta.dir, "../packages/bun-validation");
const templateDir = join(import.meta.dir, "../.bun-create/bun-validation");

describe("bun-validation crate", () => {
  it("resolves the public API from the package name", () => {
    expect(typeof validateAll).toBe("function");
    expect(typeof CLI_VERSION).toBe("string");
    expect(normalizeVersion("bun-v1.2.3")).toBe("1.2.3");
  });

  it("declares a bin and main entry", async () => {
    const pkg = await Bun.file(`${crateDir}/package.json`).json();
    expect(pkg.name).toBe("bun-validation");
    expect(pkg.main).toBe("./src/index.ts");
    expect(pkg.bin["bun-validate"]).toBe("./src/bin.ts");
    expect(pkg.type).toBe("module");
  });

  it("ships a bun create template with a passing sample release", async () => {
    const tmpl = await Bun.file(`${templateDir}/package.json`).json();
    expect(tmpl.scripts.validate).toBe("bun-validate");
    expect(tmpl.dependencies["bun-validation"]).toBeDefined();

    const report = await validateAll("0.0.0", {
      compareSnapshot: false,
      baseDir: `${templateDir}/releases/bun-v0.0.0`,
    });
    expect(report.valid).toBe(true);
  });
});

describe("init-validation", () => {
  it("layers the crate onto bun init -y", async () => {
    const dest = await mkdtemp(join(tmpdir(), "init-val-"));
    try {
      const proc = Bun.spawn({
        cmd: ["bun", "scripts/init-validation.ts", dest],
        cwd: join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      expect(code, `${stdout}\n${stderr}`).toBe(0);

      const pkg = await Bun.file(`${dest}/package.json`).json();
      expect(pkg.scripts.validate).toBe("bun-validate");
      expect(pkg.scripts["validate:all"]).toBeDefined();

      const extracted = Bun.file(`${dest}/releases/bun-v0.0.0/extracted.json`);
      expect(await extracted.exists()).toBe(true);

      const check = await validateAll("0.0.0", {
        compareSnapshot: false,
        baseDir: `${dest}/releases/bun-v0.0.0`,
      });
      expect(check.valid).toBe(true);
    } finally {
      await rm(dest, { recursive: true, force: true });
    }
  });
});
