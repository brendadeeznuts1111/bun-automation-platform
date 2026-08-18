/**
 * Cross-reference chain integrity gate.
 *
 * XREF: Bug cross-reference chain — see docs/render-diagrams.ts#cross-reference-chain
 *
 * Parses the `## Cross-Reference Chain` section of `docs/render-diagrams.ts`
 * (the anchor every `XREF: Bug cross-reference chain` comment in tests/*
 * points to) and asserts, from the bug blocks themselves:
 *
 *  1. every Bug C1–C7 / 12–41 block is present exactly once;
 *  2. every test/doc `file:line` reference resolves to a real file and line;
 *  3. the Status Breakdown and Severity Breakdown match the blocks;
 *  4. the Summary Statistics match the blocks;
 *  5. the Test File → Bug Coverage Map covers every XREF-bearing test file;
 *  6. every `XREF` comment in tests/ points at the `## Cross-Reference Chain`
 *     heading (so the anchor never dangles again).
 *
 * When a block's status/severity/test/doc changes without updating the
 * breakdowns, this test fails with the exact mismatch.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DOC_PATH = join(ROOT, "docs", "render-diagrams.ts");
const doc = readFileSync(DOC_PATH, "utf8");

/** Unquote one line of the doc's TS string array (handles `\`` and `\"` escapes). */
function unquote(line: string): string {
  return line
    .replace(/^\s*"/, "")
    .replace(/",?\s*$/, "")
    .replace(/\\`/g, "`")
    .replace(/\\"/g, '"');
}

const lines = doc.split("\n").map(unquote);

function marker(prefix: string): number {
  const i = lines.findIndex((l) => l.startsWith(prefix));
  if (i < 0) throw new Error(`missing marker in docs/render-diagrams.ts: ${prefix}`);
  return i;
}

const chainStart = marker("## Cross-Reference Chain");
const chainEnd = marker("## Related");
const chain = lines.slice(chainStart, chainEnd);

function subSection(fromPrefix: string, toPrefix?: string): string[] {
  const start = chain.findIndex((l) => l.startsWith(fromPrefix));
  if (start < 0) throw new Error(`missing subsection: ${fromPrefix}`);
  const relEnd = toPrefix ? chain.findIndex((l, i) => i > start && l.startsWith(toPrefix)) : -1;
  return chain.slice(start + 1, relEnd < 0 ? chain.length : relEnd);
}

interface Ref {
  file: string;
  line?: number;
}

interface Bug {
  id: string;
  status: string;
  severity: string;
  tests: Ref[];
  docs: Ref[];
}

function parseRefs(val: string): Ref[] {
  const refs: Ref[] = [];
  for (const m of val.matchAll(/`([^`]+\.(?:test\.ts|ts))(?::(\d+))?`/g)) {
    refs.push({ file: m[1] ?? "", line: m[2] ? Number(m[2]) : undefined });
  }
  return refs;
}

function parseBugBlocks(sec: string[]): Bug[] {
  const bugs: Bug[] = [];
  let cur: Bug | null = null;
  for (const l of sec) {
    const start = l.match(/^- \*\*Bug (C?\d+)\*\*:/);
    if (start) {
      cur = { id: start[1] ?? "", status: "", severity: "", tests: [], docs: [] };
      bugs.push(cur);
      continue;
    }
    if (!cur) continue;
    const f = l.match(/^ {3}- \*\*([A-Za-z]+)\*\*: (.*)$/);
    if (!f) continue;
    const [, key, val] = f;
    if (key === "Status") cur.status = val ?? "";
    else if (key === "Severity") cur.severity = val ?? "";
    else if (key === "Test") cur.tests.push(...parseRefs(val ?? ""));
    else if (key === "Doc") cur.docs.push(...parseRefs(val ?? ""));
  }
  return bugs;
}

function expandIds(spec: string): string[] {
  const ids: string[] = [];
  for (let tok of spec.split(",")) {
    tok = tok
      .trim()
      .replace(/\(.*\)$/, "")
      .trim();
    if (!tok) continue;
    const range = tok.match(/^(C?)(\d+)\s*[–-]\s*(C?)(\d+)$/);
    if (range) {
      const p = range[1] ?? range[3];
      const from = Number(range[2]);
      const to = Number(range[4]);
      for (let n = from; n <= to; n++) ids.push(`${p}${n}`);
      continue;
    }
    const single = tok.match(/^(C?)(\d+)$/);
    if (single) ids.push(`${single[1]}${single[2]}`);
  }
  return ids;
}

/** Claimed ids from a breakdown line like `- **P1** (label): 13 — C1, C2, ...`. */
function breakdownParts(line: string): { label: string; count: number; ids: string[] } | null {
  const m = line.match(/^- \*\*([\w-]+)\*\*(?: \(([^)]*)\))?: (\d+) — (.+)$/);
  if (!m) return null;
  return { label: m[1] ?? "", count: Number(m[3]), ids: expandIds(m[4] ?? "") };
}

const fileLines = (path: string): number => readFileSync(path, "utf8").split("\n").length;

function checkRefs(refs: Ref[], what: string): void {
  for (const r of refs) {
    const abs = join(ROOT, r.file);
    expect(existsSync(abs), `${what} file missing: ${r.file}`).toBe(true);
    if (r.line !== undefined) {
      expect(
        r.line <= fileLines(abs),
        `${what} line out of range: ${r.file}:${r.line} (file has ${fileLines(abs)} lines)`,
      ).toBe(true);
    }
  }
}

const channelSec = subSection("### Channel Bugs", "### Bun Runtime API Bugs");
const runtimeSec = subSection("### Bun Runtime API Bugs", "### Bugs without dedicated tests");
const channelBugs = parseBugBlocks(channelSec);
const runtimeBugs = parseBugBlocks(runtimeSec);
const bugs = [...channelBugs, ...runtimeBugs];

describe("cross-reference chain: bug blocks", () => {
  test("C1–C7 and 12–41 are all present exactly once", () => {
    const expected: string[] = [];
    for (let n = 1; n <= 7; n++) expected.push(`C${n}`);
    for (let n = 12; n <= 41; n++) expected.push(String(n));
    expect(bugs.map((b) => b.id).sort()).toEqual(expected.sort());
  });

  test("every block has a status and severity", () => {
    for (const b of bugs) {
      expect(b.status, `${b.id} missing Status`).not.toBe("");
      expect(b.severity, `${b.id} missing Severity`).not.toBe("");
    }
  });

  test("all test refs resolve to real files and lines", () => {
    for (const b of bugs) checkRefs(b.tests, `${b.id} test`);
  });

  test("all doc refs resolve to real lines in the doc", () => {
    for (const b of bugs) checkRefs(b.docs, `${b.id} doc`);
  });
});

describe("cross-reference chain: breakdowns match blocks", () => {
  test("Status Breakdown counts and ids match the blocks", () => {
    const statusSec = subSection("### Status Breakdown", "### Severity Breakdown");
    const byStatus = new Map<string, string[]>();
    for (const b of bugs) byStatus.set(b.status, [...(byStatus.get(b.status) ?? []), b.id]);

    const claimed = statusSec.map(breakdownParts).filter((x): x is NonNullable<typeof x> => x !== null);
    expect(claimed.length).toBeGreaterThan(0);

    for (const c of claimed) {
      const derived = byStatus.get(c.label) ?? [];
      expect(derived.length, `${c.label} count`).toBe(c.count);
      expect(derived.sort(), `${c.label} ids`).toEqual([...c.ids].sort());
    }
  });

  test("Severity Breakdown counts and ids match the blocks", () => {
    const sevSec = subSection("### Severity Breakdown", "### Summary Statistics");
    const bySev = new Map<string, string[]>();
    for (const b of bugs) {
      const sev = b.severity.split(" ")[0] ?? "P?"; // e.g. "P1 (silent wrong output)" -> "P1"
      bySev.set(sev, [...(bySev.get(sev) ?? []), b.id]);
    }

    const claimed = sevSec.map(breakdownParts).filter((x): x is NonNullable<typeof x> => x !== null);
    expect(claimed.length).toBeGreaterThan(0);

    for (const c of claimed) {
      const derived = bySev.get(c.label) ?? [];
      expect(derived.length, `${c.label} count`).toBe(c.count);
      expect(derived.sort(), `${c.label} ids`).toEqual([...c.ids].sort());
    }
  });

  test("Summary Statistics match the blocks", () => {
    const sumSec = subSection("### Summary Statistics", "### Test File");
    const withTest = bugs.filter((b) => b.tests.length > 0);
    const withDoc = bugs.filter((b) => b.docs.length > 0);
    const both = bugs.filter((b) => b.tests.length > 0 && b.docs.length > 0);
    const runtimeNoTest = runtimeBugs.filter((b) => b.tests.length === 0);
    const runtimeNoDoc = runtimeBugs.filter((b) => b.docs.length === 0);

    const claimedWith = (label: string): number | null => {
      const m = sumSec.find((l) => l.startsWith(`- Bugs with ${label}: `));
      return m ? Number(m.match(/: (\d+)$/)?.[1]) : null;
    };
    const claimedWithout = (label: string): { count: number; ids: string[] } | null => {
      const m = sumSec.find((l) => l.startsWith(`- Bugs without ${label}: `));
      if (!m) return null;
      const parts = m.match(/^- Bugs without .+: (\d+) — (.+)$/);
      return parts ? { count: Number(parts[1]), ids: expandIds(parts[2] ?? "") } : null;
    };

    expect(claimedWith("dedicated tests")).toBe(withTest.length);
    expect(claimedWith("doc entries")).toBe(withDoc.length);
    expect(claimedWith("both test + doc")).toBe(both.length);

    const noTest = claimedWithout("dedicated tests");
    expect(noTest?.count).toBe(runtimeNoTest.length);
    expect(noTest?.ids.sort()).toEqual(runtimeNoTest.map((b) => b.id).sort());

    const noDoc = claimedWithout("doc entries");
    expect(noDoc?.count).toBe(runtimeNoDoc.length);
    expect(noDoc?.ids.sort()).toEqual(runtimeNoDoc.map((b) => b.id).sort());
  });
});

const mapSec = subSection("### Test File");
const mapEntries = mapSec
  .map((l) => l.match(/^- `([^`]+\.test\.ts)` — (.*)$/))
  .filter((m): m is RegExpMatchArray => m !== null)
  .map((m) => ({ file: m[1] ?? "", desc: m[2] ?? "" }));

const xrefFiles = readdirSync(join(ROOT, "tests"))
  .filter((f) => f.endsWith(".test.ts"))
  .filter((f) => readFileSync(join(ROOT, "tests", f), "utf8").includes("XREF: Bug cross-reference chain"))
  .sort();

describe("cross-reference chain: coverage map", () => {
  test("every map entry exists on disk", () => {
    for (const e of mapEntries) {
      expect(existsSync(join(ROOT, e.file)), `map file missing: ${e.file}`).toBe(true);
    }
  });

  test("every XREF-bearing test file appears in the map", () => {
    const mapped = mapEntries.map((e) => e.file).sort();
    const missing = xrefFiles.filter((f) => !mapped.includes(`tests/${f}`));
    expect(missing, `missing from coverage map: ${missing.join(", ")}`).toEqual([]);
  });

  test("every bug test ref file appears in the map", () => {
    const mapped = mapEntries.map((e) => e.file).sort();
    const missing = [...new Set(bugs.flatMap((b) => b.tests.map((t) => t.file)))].filter((f) => !mapped.includes(f));
    expect(missing, `missing from coverage map: ${missing.join(", ")}`).toEqual([]);
  });

  test("'Test files covering bugs' matches the map", () => {
    const sumSec = subSection("### Summary Statistics", "### Test File");
    const claimed = Number(sumSec.find((l) => l.startsWith("- Test files covering bugs: "))?.match(/: (\d+)$/)?.[1]);
    const bugIdToken = /(?:^|[,\s])(C[1-7]|[12][0-9]|3[0-9]|4[01])(?:[,\s]|$)/;
    const covering = mapEntries.filter((e) => bugIdToken.test(e.desc.split("(")[0] ?? "")).length;
    expect(covering, "files covering bugs").toBe(claimed);
  });
});

describe("cross-reference chain: XREF anchor contract", () => {
  test("the chain heading exists exactly as the XREF anchor expects", () => {
    expect(lines.includes("## Cross-Reference Chain"), "missing `## Cross-Reference Chain`").toBe(true);
  });

  test("every XREF comment points at docs/render-diagrams.ts#cross-reference-chain", () => {
    for (const f of xrefFiles) {
      const content = readFileSync(join(ROOT, "tests", f), "utf8");
      expect(
        content.includes("docs/render-diagrams.ts#cross-reference-chain"),
        `${f} XREF comment does not point at docs/render-diagrams.ts#cross-reference-chain`,
      ).toBe(true);
    }
  });
});
