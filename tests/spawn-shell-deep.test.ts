/**
 * Deep audit: Bun.spawn, Bun.spawnSync, Bun.$ shell — Bugs 37-40.
 *
 * XREF: Bug cross-reference chain — see docs/render-diagrams.ts#cross-reference-chain
 * This file covers Bug 37, 38, 39, 40 (doc:2335)
 *
 * Verifies:
 * - Bug 37: Bun.pid is undefined (process.pid works)
 * - Bug 38: Bun.now() does not exist
 * - Bug 39: Bun.Timer does not exist
 * - Bug 40: Bun.spawnSync `input` option doesn't pipe to stdin
 * - Bun.spawn: stdout/stderr capture, env, cwd, exit codes
 * - Bun.spawnSync: stdout as Buffer, timeout
 * - Bun.$: templates, interpolation, pipes, cwd, env, nothrow, quiet
 *
 * Ref: https://bun.com/docs/runtime/spawn
 * Ref: https://bun.com/docs/runtime/shell
 */

import { describe, expect, test } from "bun:test";

describe("Bug 37: Bun.pid is undefined", () => {
  test("Bun.pid is undefined (process.pid works)", () => {
    // JUSTIFIED: Bun.pid doesn't exist in bun-types but is documented
    expect((Bun as Record<string, unknown>).pid).toBeUndefined();
    expect(process.pid).toBeGreaterThan(0);
  });
});

describe("Bug 38: Bun.now() does not exist", () => {
  test("Bun.now is undefined", () => {
    // JUSTIFIED: accessing potentially undefined property
    expect((Bun as Record<string, unknown>).now).toBeUndefined();
  });
});

describe("Bug 39: Bun.Timer does not exist", () => {
  test("Bun.Timer is undefined", () => {
    // JUSTIFIED: accessing potentially undefined property
    expect((Bun as Record<string, unknown>).Timer).toBeUndefined();
  });
});

describe("Bun.spawn", () => {
  test("captures stdout", async () => {
    const proc = Bun.spawn({ cmd: ["echo", "hello"], stdin: "ignore", stdout: "pipe" });
    const text = await new Response(proc.stdout).text();
    expect(text.trim()).toBe("hello");
    expect(await proc.exited).toBe(0);
  });

  test("captures stderr", async () => {
    const proc = Bun.spawn({
      cmd: ["sh", "-c", "echo to-stderr 1>&2"],
      stdin: "ignore",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    expect(stderr.trim()).toBe("to-stderr");
  });

  test("env option sets environment variables", async () => {
    const proc = Bun.spawn({
      cmd: ["sh", "-c", "echo $MY_TEST_VAR"],
      stdin: "ignore",
      stdout: "pipe",
      env: { ...process.env, MY_TEST_VAR: "env-test" },
    });
    const out = await new Response(proc.stdout).text();
    expect(out.trim()).toBe("env-test");
  });

  test("cwd option sets working directory", async () => {
    const proc = Bun.spawn({ cmd: ["pwd"], cwd: "/tmp", stdin: "ignore", stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    // On macOS, /tmp is a symlink to /private/tmp
    expect(out.trim()).toMatch(/\/tmp$/);
  });

  test("non-existent command throws", () => {
    expect(() => Bun.spawn(["nonexistent-cmd-xyz-123"])).toThrow();
  });

  test("exit code propagation", async () => {
    const proc = Bun.spawn({ cmd: ["sh", "-c", "exit 42"], stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    expect(await proc.exited).toBe(42);
  });

  test("signal exit detection", async () => {
    const proc = Bun.spawn({ cmd: ["sh", "-c", "kill -TERM $$"], stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    expect(proc.signalCode).toBe("SIGTERM");
  });
});

describe("Bun.spawnSync", () => {
  test("captures stdout as Buffer", () => {
    const sync = Bun.spawnSync(["echo", "sync-test"]);
    expect(sync.stdout).toBeDefined();
    expect(sync.stdout!.toString().trim()).toBe("sync-test");
  });

  test("exitCode is set", () => {
    const sync = Bun.spawnSync(["sh", "-c", "exit 7"]);
    expect(sync.exitCode).toBe(7);
  });

  test("timeout kills process", () => {
    const sync = Bun.spawnSync({
      cmd: ["sleep", "10"],
      timeout: 100,
    } as never);
    expect(sync.signalCode).toBe("SIGTERM");
    expect(sync.exitCode).toBeNull();
  });

  test("Bug 40: input option doesn't pipe to stdin", () => {
    // Bug: spawnSync with `input` option should pipe to stdin
    // but the output is empty (input is not sent)
    // JUSTIFIED: bun-types uses `cmd` but type expects string[] directly
    const sync = Bun.spawnSync({
      cmd: ["cat"],
      input: "test-input-data",
    } as never);
    // Bug: stdout should be "test-input-data" but is empty
    expect(sync.stdout?.toString() ?? "").toBe("");
  });
});

describe("Bun.$ shell", () => {
  test("basic command returns stdout", async () => {
    const out = await Bun.$`echo hello`.text();
    expect(out.trim()).toBe("hello");
  });

  test("template interpolation", async () => {
    const name = "world";
    const out = await Bun.$`echo hello ${name}`.text();
    expect(out.trim()).toBe("hello world");
  });

  test("pipe with |", async () => {
    const out = await Bun.$`echo "test" | cat`.text();
    expect(out.trim()).toBe("test");
  });

  test("multiple commands with &&", async () => {
    const out = await Bun.$`echo first && echo second`.text();
    expect(out).toContain("first");
    expect(out).toContain("second");
  });

  test("quiet() suppresses terminal output", async () => {
    const result = await Bun.$`echo quiet-test`.quiet();
    expect(result.stdout.toString().trim()).toBe("quiet-test");
  });

  test("nothrow() doesn't throw on failure", async () => {
    const result = await Bun.$`exit 42`.nothrow();
    expect(result.exitCode).toBe(42);
  });

  test("failing command throws", async () => {
    let threw = false;
    try {
      await Bun.$`exit 1`;
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("cwd() sets working directory", async () => {
    const out = await Bun.$`pwd`.cwd("/tmp").text();
    expect(out.trim()).toBe("/tmp");
  });

  test("env() sets environment", async () => {
    const out = await Bun.$`echo $SHELL_TEST_VAR`.env({ ...process.env, SHELL_TEST_VAR: "shell-env" }).text();
    expect(out.trim()).toBe("shell-env");
  });

  test("array interpolation", async () => {
    const args = ["arg1", "arg2", "arg3"];
    const out = await Bun.$`echo ${args}`.text();
    expect(out.trim()).toContain("arg1");
    expect(out.trim()).toContain("arg2");
    expect(out.trim()).toContain("arg3");
  });

  test("escaping dangerous input", async () => {
    const dangerous = "hello; rm -rf /";
    const out = await Bun.$`echo ${dangerous}`.text();
    // The dangerous input should be escaped, not executed
    expect(out.trim()).toBe("hello; rm -rf /");
  });
});
