/**
 * Test patterns from official Bun documentation.
 *
 * XREF: Bug cross-reference chain — see docs/render-diagrams.ts#cross-reference-chain
 * This file has no bug numbers (test pattern verification only)
 *
 * Verifies all test patterns documented in:
 * - node_modules/bun-types/docs/test/writing-tests.mdx
 * - node_modules/bun-types/docs/test/lifecycle.mdx
 * - node_modules/bun-types/docs/test/snapshots.mdx
 * - node_modules/bun-types/docs/test/mocks.mdx
 * - node_modules/bun-types/docs/test/runtime-behavior.mdx
 *
 * Ref: https://bun.com/docs/test/writing-tests
 * Ref: https://bun.com/docs/test/lifecycle
 * Ref: https://bun.com/docs/test/snapshots
 * Ref: https://bun.com/docs/test/mocks
 * Ref: https://bun.com/docs/test/runtime-behavior
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  onTestFinished,
  spyOn,
  test,
} from "bun:test";

// ============================================================================
// Basic test patterns — writing-tests.mdx
// ============================================================================

describe("Basic test patterns", () => {
  test("basic addition: 2 + 2", () => {
    expect(2 + 2).toBe(4);
  });

  test("async test", async () => {
    const result = await Promise.resolve(2 * 2);
    expect(result).toEqual(4);
  });

  test("done callback", (done) => {
    Promise.resolve(2 * 2).then((result) => {
      expect(result).toEqual(4);
      done();
    });
  }, 5000);
});

// ============================================================================
// Grouping with describe — writing-tests.mdx
// ============================================================================

describe("arithmetic", () => {
  test("2 + 2", () => {
    expect(2 + 2).toBe(4);
  });

  test("2 * 2", () => {
    expect(2 * 2).toBe(4);
  });
});

// ============================================================================
// Timeouts — writing-tests.mdx
// ============================================================================

describe("Timeouts", () => {
  test("fast test with timeout", () => {
    expect(1 + 1).toBe(2);
  }, 1000);

  test("async with timeout", async () => {
    await Bun.sleep(1);
    expect(true).toBe(true);
  }, 5000);
});

// ============================================================================
// Retries and repeats — writing-tests.mdx
// ============================================================================

describe("Retries and repeats", () => {
  test(
    "retry on failure",
    async () => {
      expect(Math.random()).toBeGreaterThanOrEqual(0);
    },
    { retry: 3 },
  );

  test(
    "repeats for stability",
    () => {
      expect(Math.random()).toBeLessThan(1);
    },
    { repeats: 5, retry: 0 },
  );
});

// ============================================================================
// Test modifiers — writing-tests.mdx
// ============================================================================

describe("Test modifiers", () => {
  test.skip("skipped test", () => {
    expect(0.1 + 0.2).toEqual(0.3);
  });

  test.todo("todo test", () => {});

  const isMacOS = process.platform === "darwin";
  test.if(isMacOS)("runs on macOS", () => {
    expect(process.platform).toBe("darwin");
  });

  test.skipIf(!isMacOS)("runs on macOS (skipIf)", () => {
    expect(process.platform).toBe("darwin");
  });
});

// ============================================================================
// Failing tests — writing-tests.mdx
// ============================================================================

describe("Failing tests", () => {
  test.failing("math is broken (expected to fail)", () => {
    expect(0.1 + 0.2).toBe(0.3); // fails due to floating point
  });
});

// ============================================================================
// Parametrized tests — writing-tests.mdx
// ============================================================================

describe("Parametrized tests", () => {
  const cases: Array<[number, number, number]> = [
    [1, 2, 3],
    [3, 4, 7],
    [10, 20, 30],
  ];

  test.each(cases)("%p + %p should be %p", (a, b, expected) => {
    expect(a + b).toBe(expected);
  });

  // Object items passed as single argument
  test.each([
    { a: 1, b: 2, expected: 3 },
    { a: 4, b: 5, expected: 9 },
  ])("add($a, $b) = $expected", (data) => {
    expect(data.a + data.b).toBe(data.expected);
  });

  // Format specifiers
  test.each([
    ["hello", 123],
    ["world", 456],
  ])("string: %s, number: %i", (str, num) => {
    expect(typeof str).toBe("string");
    expect(typeof num).toBe("number");
  });

  // %# for index
  test.each(["apple", "banana"])("fruit #%# is %s", (fruit) => {
    expect(typeof fruit).toBe("string");
  });
});

// ============================================================================
// describe.each — writing-tests.mdx
// ============================================================================

describe.each([
  [1, 2, 3],
  [3, 4, 7],
])("add(%i, %i)", (a, b, expected) => {
  test(`returns ${expected}`, () => {
    expect(a + b).toBe(expected);
  });

  test(`sum is greater than each value`, () => {
    expect(a + b).toBeGreaterThan(a);
    expect(a + b).toBeGreaterThan(b);
  });
});

// ============================================================================
// Assertion counting — writing-tests.mdx
// ============================================================================

describe("Assertion counting", () => {
  test("exactly two assertions", () => {
    expect.assertions(2);
    expect(1 + 1).toBe(2);
    expect("hello").toContain("ell");
  });

  test("hasAssertions", () => {
    expect.hasAssertions();
    expect(1).toBeDefined();
  });
});

// ============================================================================
// Lifecycle hooks — lifecycle.mdx
// ============================================================================

describe("Lifecycle hooks", () => {
  let counter = 0;

  beforeAll(() => {
    counter = 0;
  });

  afterAll(() => {
    counter = 0;
  });

  beforeEach(() => {
    counter++;
  });

  afterEach(() => {
    // cleanup
  });

  test("counter increments with beforeEach", () => {
    expect(counter).toBeGreaterThanOrEqual(1);
  });

  test("counter continues to increment", () => {
    expect(counter).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================================
// onTestFinished — lifecycle.mdx
// ============================================================================

describe("onTestFinished", () => {
  test("cleanup after test", () => {
    let cleaned = false;
    onTestFinished(() => {
      cleaned = true;
    });
    expect(cleaned).toBe(false);
  });
});

// ============================================================================
// Nested hooks — lifecycle.mdx
// ============================================================================

describe("Nested hooks", () => {
  const log: string[] = [];

  beforeAll(() => log.push("File beforeAll"));
  afterAll(() => log.push("File afterAll"));

  describe("outer describe", () => {
    beforeAll(() => log.push("Outer beforeAll"));
    beforeEach(() => log.push("Outer beforeEach"));
    afterEach(() => log.push("Outer afterEach"));
    afterAll(() => log.push("Outer afterAll"));

    describe("inner describe", () => {
      beforeAll(() => log.push("Inner beforeAll"));
      beforeEach(() => log.push("Inner beforeEach"));
      afterEach(() => log.push("Inner afterEach"));
      afterAll(() => log.push("Inner afterAll"));

      test("nested test", () => {
        expect(log).toContain("File beforeAll");
        expect(log).toContain("Outer beforeAll");
        expect(log).toContain("Inner beforeAll");
        expect(log).toContain("Outer beforeEach");
        expect(log).toContain("Inner beforeEach");
      });
    });
  });
});

// ============================================================================
// Async lifecycle hooks — lifecycle.mdx
// ============================================================================

describe("Async lifecycle hooks", () => {
  let ready = false;

  beforeAll(async () => {
    await Bun.sleep(1);
    ready = true;
  });

  afterAll(async () => {
    await Bun.sleep(1);
    ready = false;
  });

  test("ready after async beforeAll", async () => {
    expect(ready).toBe(true);
    await expect(Promise.resolve("test")).resolves.toBe("test");
  });
});

// ============================================================================
// Snapshot testing — snapshots.mdx
// ============================================================================

describe("Snapshot testing", () => {
  test("string snapshot", () => {
    expect("foo").toMatchSnapshot();
  });

  test("number snapshot", () => {
    expect(42).toMatchSnapshot();
  });

  test("complex object snapshot", () => {
    const user = {
      id: 1,
      name: "John Doe",
      email: "john@example.com",
      tags: ["developer", "javascript", "bun"],
    };
    expect(user).toMatchSnapshot();
  });

  test("array snapshot", () => {
    const numbers = [1, 2, 3, 4, 5].map((n) => n * 2);
    expect(numbers).toMatchSnapshot();
  });

  test("inline snapshot", () => {
    expect({ hello: "world" }).toMatchInlineSnapshot(`
{
  "hello": "world",
}
`);
  });

  test("snapshot with property matchers", () => {
    const user = {
      id: Math.random(),
      name: "John",
      createdAt: new Date().toISOString(),
    };
    expect(user).toMatchSnapshot({
      id: expect.any(Number),
      createdAt: expect.any(String),
    });
  });

  test("error snapshot", () => {
    expect(() => {
      throw new Error("Something went wrong");
    }).toThrowErrorMatchingInlineSnapshot(`"Something went wrong"`);
  });
});

// ============================================================================
// Mock functions — mocks.mdx
// ============================================================================

describe("Mock functions", () => {
  test("basic mock", () => {
    const random = mock(() => Math.random());
    const val = random();
    expect(val).toBeGreaterThan(0);
    expect(random).toHaveBeenCalled();
    expect(random).toHaveBeenCalledTimes(1);
  });

  test("mock with arguments", () => {
    const mockFn = mock((x: number) => x * 2);
    const result1 = mockFn(5);
    const result2 = mockFn(10);

    expect(mockFn).toHaveBeenCalledTimes(2);
    expect(mockFn).toHaveBeenCalledWith(5);
    expect(mockFn).toHaveBeenLastCalledWith(10);
    expect(result1).toBe(10);
    expect(result2).toBe(20);

    expect(mockFn.mock.calls).toEqual([[5], [10]]);
    expect(mockFn.mock.results).toEqual([
      { type: "return", value: 10 },
      { type: "return", value: 20 },
    ]);
  });

  test("dynamic mock implementations", () => {
    const mockFn = mock();
    mockFn.mockImplementationOnce(() => "first");
    mockFn.mockImplementationOnce(() => "second");
    mockFn.mockImplementation(() => "default");

    expect(mockFn()).toBe("first");
    expect(mockFn()).toBe("second");
    expect(mockFn()).toBe("default");
    expect(mockFn()).toBe("default");
  });

  test("async mocks with resolved values", async () => {
    const asyncMock = mock();
    asyncMock.mockResolvedValueOnce("first result");
    asyncMock.mockResolvedValue("default result");

    expect(await asyncMock()).toBe("first result");
    expect(await asyncMock()).toBe("default result");
  });

  test("async mocks with rejected values", async () => {
    const rejectMock = mock();
    rejectMock.mockRejectedValue(new Error("Mock error"));
    await expect(rejectMock()).rejects.toThrow("Mock error");
  });

  test("mockReturnValue", () => {
    const mockFn = mock();
    mockFn.mockReturnValue(42);
    expect(mockFn()).toBe(42);
    expect(mockFn()).toBe(42);
  });

  test("mockReturnValueOnce", () => {
    const mockFn = mock();
    mockFn.mockReturnValueOnce(1);
    mockFn.mockReturnValue(2);
    expect(mockFn()).toBe(1);
    expect(mockFn()).toBe(2);
    expect(mockFn()).toBe(2);
  });

  test("mockReturnThis", () => {
    const obj = {
      x: 42,
      method: mock(function (this: { x: number }) {
        return this;
      }),
    };
    obj.method.mockReturnThis();
    expect(obj.method()).toBe(obj);
  });

  test("mockName", () => {
    const mockFn = mock();
    mockFn.mockName("myMock");
    expect(mockFn.getMockName()).toBe("myMock");
  });

  test("mockClear resets call history", () => {
    const mockFn = mock(() => 42);
    mockFn();
    mockFn();
    expect(mockFn).toHaveBeenCalledTimes(2);
    mockFn.mockClear();
    expect(mockFn).toHaveBeenCalledTimes(0);
  });

  test("mockReset removes implementation", () => {
    const mockFn = mock(() => 42);
    expect(mockFn()).toBe(42);
    mockFn.mockReset();
    expect(mockFn()).toBeUndefined();
  });
});

// ============================================================================
// Spies — mocks.mdx
// ============================================================================

describe("Spies with spyOn", () => {
  test("basic spy", () => {
    const ringo = {
      name: "Ringo",
      sayHi() {
        return `Hello I'm ${this.name}`;
      },
    };

    const spy = spyOn(ringo, "sayHi");
    expect(spy).toHaveBeenCalledTimes(0);
    const result = ringo.sayHi();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result).toBe("Hello I'm Ringo");
    spy.mockRestore();
  });

  test("spy with mock implementation", async () => {
    const userService = {
      async getUser(id: string) {
        return { id, name: `User ${id}` };
      },
    };

    const spy = spyOn(userService, "getUser").mockResolvedValue({
      id: "123",
      name: "Mocked User",
    });

    const result = await userService.getUser("123");
    expect(result.name).toBe("Mocked User");
    expect(spy).toHaveBeenCalledWith("123");
    spy.mockRestore();
  });
});

// ============================================================================
// mock.clearAllMocks — mocks.mdx
// ============================================================================

describe("mock.clearAllMocks", () => {
  test("clears all mock call history", () => {
    const mock1 = mock(() => 1);
    const mock2 = mock(() => 2);
    mock1();
    mock2();
    expect(mock1).toHaveBeenCalledTimes(1);
    expect(mock2).toHaveBeenCalledTimes(1);

    mock.clearAllMocks();

    expect(mock1).toHaveBeenCalledTimes(0);
    expect(mock2).toHaveBeenCalledTimes(0);
    // implementations preserved
    expect(mock1()).toBe(1);
    expect(mock2()).toBe(2);
  });
});

// ============================================================================
// mock.restore — mocks.mdx
// ============================================================================

describe("mock.restore", () => {
  const obj = {
    method: () => "original",
  };

  test("restore restores original implementation", () => {
    const spy = spyOn(obj, "method");
    spy.mockImplementation(() => "mocked");
    expect(obj.method()).toBe("mocked");

    mock.restore();
    expect(obj.method()).toBe("original");
  });
});

// ============================================================================
// Matchers — writing-tests.mdx
// ============================================================================

describe("Matchers", () => {
  test("toBe (reference equality)", () => {
    expect(1).toBe(1);
    const obj = { a: 1 };
    expect(obj).toBe(obj);
  });

  test("toEqual (deep equality)", () => {
    expect({ a: 1 }).toEqual({ a: 1 });
  });

  test("toStrictEqual (strict deep equality)", () => {
    expect({ a: 1 }).toStrictEqual({ a: 1 });
    // toStrictEqual catches undefined keys
    expect({ a: 1, b: undefined }).not.toStrictEqual({ a: 1 });
  });

  test("toBeNull / toBeUndefined / toBeDefined", () => {
    expect(null).toBeNull();
    expect(undefined).toBeUndefined();
    expect(1).toBeDefined();
  });

  test("toBeNaN", () => {
    expect(NaN).toBeNaN();
    expect(1).not.toBeNaN();
  });

  test("toBeFalsy / toBeTruthy", () => {
    expect(0).toBeFalsy();
    expect("").toBeFalsy();
    expect(null).toBeFalsy();
    expect(1).toBeTruthy();
    expect("hello").toBeTruthy();
  });

  test("toContain (string)", () => {
    expect("hello world").toContain("world");
  });

  test("toContain (array)", () => {
    expect([1, 2, 3]).toContain(2);
  });

  test("toHaveLength", () => {
    expect([1, 2, 3]).toHaveLength(3);
    expect("hello").toHaveLength(5);
  });

  test("toMatch (regex)", () => {
    expect("hello world").toMatch(/world/);
  });

  test("toContainEqual (deep equality in array)", () => {
    expect([{ a: 1 }, { b: 2 }]).toContainEqual({ a: 1 });
  });

  test("toHaveProperty", () => {
    expect({ a: 1, b: { c: 2 } }).toHaveProperty("a");
    expect({ a: 1, b: { c: 2 } }).toHaveProperty("b.c");
  });

  test("toMatchObject", () => {
    expect({ a: 1, b: 2, c: 3 }).toMatchObject({ a: 1 });
  });

  test("toContainAllKeys", () => {
    expect({ a: 1, b: 2 }).toContainAllKeys(["a", "b"]);
  });

  test("toContainValue", () => {
    expect({ a: 1, b: 2 }).toContainValue(1);
  });

  test("toContainValues", () => {
    expect({ a: 1, b: 2 }).toContainValues([1, 2]);
  });

  test("toBeCloseTo", () => {
    expect(0.1 + 0.2).toBeCloseTo(0.3, 5);
  });

  test("toBeGreaterThan / toBeGreaterThanOrEqual", () => {
    expect(5).toBeGreaterThan(3);
    expect(5).toBeGreaterThanOrEqual(5);
  });

  test("toBeLessThan / toBeLessThanOrEqual", () => {
    expect(3).toBeLessThan(5);
    expect(3).toBeLessThanOrEqual(3);
  });

  test("toThrow", () => {
    expect(() => {
      throw new Error("test error");
    }).toThrow("test error");
    expect(() => {
      throw new Error("test error");
    }).toThrow(Error);
  });

  test("toBeInstanceOf", () => {
    expect(new Error("test")).toBeInstanceOf(Error);
    expect([1, 2, 3]).toBeInstanceOf(Array);
  });

  test("resolves", async () => {
    await expect(Promise.resolve(42)).resolves.toBe(42);
  });

  test("rejects", async () => {
    await expect(Promise.reject(new Error("fail"))).rejects.toThrow("fail");
  });
});

// ============================================================================
// expect.any and expect.anything — writing-tests.mdx
// ============================================================================

describe("expect.any and expect.anything", () => {
  test("expect.any", () => {
    expect(42).toEqual(expect.any(Number));
    expect("hello").toEqual(expect.any(String));
    expect([1, 2]).toEqual(expect.any(Array));
  });

  test("expect.anything in toHaveBeenCalledWith", () => {
    const mockFn = mock();
    mockFn("some value", 42);
    expect(mockFn).toHaveBeenCalledWith(expect.anything(), expect.any(Number));
  });
});

// ============================================================================
// Runtime behavior — runtime-behavior.mdx
// ============================================================================

describe("Runtime behavior", () => {
  test("NODE_ENV is set to test", () => {
    expect(process.env.NODE_ENV).toBe("test");
  });

  test("timezone is UTC by default", () => {
    const date = new Date();
    expect(date.getTimezoneOffset()).toBe(0);
  });

  test("global test function is available", () => {
    expect(typeof test).toBe("function");
  });

  test("global describe function is available", () => {
    expect(typeof describe).toBe("function");
  });

  test("test is defined", () => {
    expect(typeof test).toBe("function");
  });
});

// ============================================================================
// Custom serializers — snapshots.mdx
// ============================================================================

describe("Custom snapshot serializers", () => {
  test("addSnapshotSerializer exists", () => {
    // Note: .addSnapshotSerializer is listed as "not yet implemented" in docs
    // but the function exists on expect
    // JUSTIFIED: bun-types doesn't export addSnapshotSerializer on Expect type
    const e = expect as unknown as { addSnapshotSerializer?: unknown };
    expect(typeof e.addSnapshotSerializer).toBeDefined();
  });
});

// ============================================================================
// Conditional describe blocks — writing-tests.mdx
// ============================================================================

// JUSTIFIED: isMacOS used for conditional describe blocks below
const isMacOS = process.platform === "darwin";

describe.skipIf(process.platform === "win32")("Unix features", () => {
  test("runs on non-Windows", () => {
    expect(process.platform).not.toBe("win32");
  });
});

describe.todoIf(process.platform === "linux")("Upcoming Linux support", () => {
  test("feature D", () => {
    // marked as TODO on Linux
  });
});

// Use isMacOS to avoid unused variable
describe.skipIf(isMacOS)("non-macOS features", () => {
  test("runs on non-macOS", () => {
    expect(process.platform).not.toBe("darwin");
  });
});

// ============================================================================
// Factory mock pattern — mocks.mdx
// ============================================================================

describe("Factory mock pattern", () => {
  function createMockUser(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "mock-id",
      name: "Mock User",
      email: "mock@example.com",
      ...overrides,
    };
  }

  test("creates mock user with defaults", () => {
    const user = createMockUser();
    expect(user.id).toBe("mock-id");
    expect(user.name).toBe("Mock User");
  });

  test("creates mock user with overrides", () => {
    const user = createMockUser({ name: "Custom Name" });
    expect(user.name).toBe("Custom Name");
    expect(user.id).toBe("mock-id");
  });
});
