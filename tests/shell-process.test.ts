import { describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { $ } from "bun";

describe("Bun Shell (Bun.$)", () => {
  test("executes commands and reads text output", async () => {
    const output = await $`echo "bun automation platform"`.text();
    expect(output.trim()).toBe("bun automation platform");
  });

  test("parses JSON output directly via .json()", async () => {
    const payload = { service: "platform", active: true, workers: 4 };
    const res = await $`echo ${JSON.stringify(payload)}`.json();
    expect(res).toEqual(payload);
  });

  test("pipes commands without deadlocks", async () => {
    const res = await $`printf "apple\nbanana\ncherry\n" | grep "an"`.text();
    expect(res.trim()).toBe("banana");
  });

  test("handles non-zero exit codes with .nothrow()", async () => {
    const res = await $`exit 42`.nothrow();
    expect(res.exitCode).toBe(42);
  });

  test("suppresses console output with .quiet()", async () => {
    const res = await $`echo "quiet operation"`.quiet().text();
    expect(res.trim()).toBe("quiet operation");
  });

  test("automatically escapes interpolated arguments", async () => {
    const maliciousArg = "file; rm -rf /";
    const res = await $`echo ${maliciousArg}`.text();
    expect(res.trim()).toBe("file; rm -rf /");
  });
});

describe("Bun Process Management (Bun.spawn & Bun.spawnSync)", () => {
  test("Bun.spawnSync executes synchronously and returns stdout", () => {
    const res = Bun.spawnSync(["echo", "sync process execution"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.toString().trim()).toBe("sync process execution");
  });

  test("Bun.spawn streams child process output via pipe", async () => {
    const proc = Bun.spawn({
      cmd: ["echo", "async process stream"],
      stdout: "pipe",
    });

    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;

    expect(code).toBe(0);
    expect(text.trim()).toBe("async process stream");
  });

  test("Bun.spawn tracks process PID and exit promise", async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, "-e", "process.exit(0)"],
    });

    expect(typeof proc.pid).toBe("number");
    expect(proc.pid).toBeGreaterThan(0);
    const code = await proc.exited;
    expect(code).toBe(0);
  });
});

describe("Bun Test Runner Features (bun:test)", () => {
  test("mock() tracks invocations, arguments, and return values", () => {
    const calculator = mock((a: number, b: number) => a + b);

    expect(calculator(10, 20)).toBe(30);
    expect(calculator(5, 15)).toBe(20);

    expect(calculator.mock.calls.length).toBe(2);
    expect(calculator.mock.calls[0]).toEqual([10, 20]);
    expect(calculator.mock.calls[1]).toEqual([5, 15]);
  });

  test("spyOn() intercepts and restores object methods", () => {
    const service = {
      getStatus: () => "offline",
    };

    const spy = spyOn(service, "getStatus").mockReturnValue("online");
    expect(service.getStatus()).toBe("online");
    expect(spy).toHaveBeenCalled();

    spy.mockRestore();
    expect(service.getStatus()).toBe("offline");
  });

  test("setSystemTime() freezes and restores the system clock", () => {
    const frozen = new Date("2026-05-13T12:00:00.000Z");
    setSystemTime(frozen);

    expect(new Date().toISOString()).toBe("2026-05-13T12:00:00.000Z");
    expect(Date.now()).toBe(frozen.getTime());

    // Reset clock
    setSystemTime();
    expect(new Date().getFullYear()).toBeGreaterThanOrEqual(2026);
  });
});
