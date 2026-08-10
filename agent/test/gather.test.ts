import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gather, CAPS } from "../src/stage1";

const REPO = "/Volumes/master_ssd/projects/PulseDB";
const maybe = existsSync(REPO) ? test : test.skip;

maybe("gather is deterministic: same SHA in, byte-identical pack out", async () => {
  const a = await gather({ repo: REPO, base: "origin/main", skipCargo: true });
  const b = await gather({ repo: REPO, base: "origin/main", skipCargo: true });
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});

maybe("gather stays inside its declared budget", async () => {
  const p = await gather({ repo: REPO, base: "origin/main", skipCargo: true });
  const total = CAPS.diff + CAPS.siblings + CAPS.clippy + CAPS.apiDelta;
  expect(p.budget.bytes).toBeLessThanOrEqual(total);
  expect(p.head).toMatch(/^[0-9a-f]{40}$/);
});

maybe("gather records what it truncated and what it degraded", async () => {
  const p = await gather({ repo: REPO, base: "origin/main", diffCap: 1000, skipCargo: true });
  expect(p.budget.capped).toContain("diff");
  expect(Array.isArray(p.degraded)).toBe(true);
});

/** A self-contained git repo with a base branch and a >1000-byte Rust diff. */
function fixtureRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "gather-"));
  const sh = (c: string) => Bun.spawnSync(["bash", "-lc", c], { cwd: repo });
  sh("git init -q . && git config user.email t@t && git config user.name t");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/a.rs"), "impl T {\n    fn one() {}\n}\n");
  sh("git add -A && git commit -qm base && git branch base");
  // 5 functions, each with a long doc line: enough bytes that a 1000-byte diff
  // cap must truncate, few enough symbols that the 8 KB sibling cap does not.
  const body = Array.from({ length: 5 }, (_, i) =>
    `    /// ${"documentation ".repeat(12)}\n` +
    `    fn f${i}(input: &str, count: usize) -> Result<String, Error> { Ok(format!("{input}{count}")) }`
  ).join("\n");
  writeFileSync(join(repo, "src/a.rs"), `impl T {\n${body}\n}\n`);
  sh("git add -A && git commit -qm change");
  return repo;
}

test("fixture: gather is deterministic — same SHA in, byte-identical pack out", async () => {
  const repo = fixtureRepo();
  try {
    const a = await gather({ repo, base: "base", skipCargo: true });
    const b = await gather({ repo, base: "base", skipCargo: true });
    // Guard first: determinism over an empty pack proves nothing.
    // Numbers verified against `git diff --numstat base...HEAD -- '*.rs'` on
    // the fixture (10 lines added, 1 removed) — the brief's amendment said
    // 11/1; corrected here to match reality per the brief's own instruction.
    expect(a.changed).toEqual([{ path: "src/a.rs", added: 10, removed: 1 }]);
    expect(a.diff.length).toBeGreaterThan(1000);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("fixture: gather stays inside its declared budget and reports the real head SHA", async () => {
  const repo = fixtureRepo();
  try {
    const p = await gather({ repo, base: "base", skipCargo: true });
    const total = CAPS.diff + CAPS.siblings + CAPS.clippy + CAPS.apiDelta;
    expect(p.budget.bytes).toBeLessThanOrEqual(total);
    // budget.bytes is measured over the pack while budget.bytes is still 0,
    // so it is the size of the pack with a `"bytes":0` placeholder — NOT the
    // size of the final serialized pack. Assert exactly that, so the property
    // is pinned rather than approximated.
    const measured = Buffer.byteLength(
      JSON.stringify({ ...p, budget: { ...p.budget, bytes: 0 } }), "utf8");
    expect(p.budget.bytes).toBe(measured);
    const realHead = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo })
      .stdout.toString().trim();
    expect(p.head).toBe(realHead);
    expect(p.head).toMatch(/^[0-9a-f]{40}$/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("fixture: gather records what it truncated and what it degraded", async () => {
  const repo = fixtureRepo();
  try {
    const capped = await gather({ repo, base: "base", diffCap: 1000, skipCargo: true });
    expect(capped.budget.capped).toContain("diff");
    expect(capped.diff).toContain("[truncated:");
    expect(capped.degraded).toEqual(["cargo sections skipped by caller"]);

    const uncapped = await gather({ repo, base: "base", skipCargo: true });
    expect(uncapped.budget.capped).not.toContain("diff");
    expect(uncapped.diff).not.toContain("[truncated:");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// --- Fix round 2: three review findings, three new hermetic fixtures --------

/** Writes an executable stand-in "cargo" and returns its absolute path.
 *  Mirrors lint.test.ts's fakeCargo helper: `body` receives $1, $2, ... exactly
 *  as the real cargo invocations pass them (`<sub> --version` for a `have()`
 *  probe, `<sub> <flags...>` for the real call). */
function fakeCargo(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-cargo-"));
  const path = join(dir, "cargo");
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * A fixture with `n` free (non-`impl`) functions, each touched by the diff on
 * its own line, so a `--message-format=json` clippy diagnostic pinned to line
 * `i` counts as in-scope. Free functions collect no symbols (extractSymbols
 * only groups items inside impl/trait/mod containers), which keeps this
 * fixture's `symbols` section empty and isolates the clippy-cap assertion
 * from the sibling trim exercised by a separate fixture below.
 */
function manyLinesFixtureRepo(n: number): string {
  const repo = mkdtempSync(join(tmpdir(), "gather-clippy-"));
  const sh = (c: string) => Bun.spawnSync(["bash", "-lc", c], { cwd: repo });
  sh("git init -q . && git config user.email t@t && git config user.name t");
  mkdirSync(join(repo, "src"));
  const base = Array.from({ length: n }, (_, i) => `fn f${i}() {}`).join("\n") + "\n";
  writeFileSync(join(repo, "src/a.rs"), base);
  sh("git add -A && git commit -qm base && git branch base");
  const changed = Array.from({ length: n }, (_, i) => `fn f${i}() { let _x = 1; }`).join("\n") + "\n";
  writeFileSync(join(repo, "src/a.rs"), changed);
  sh("git add -A && git commit -qm change");
  return repo;
}

/** `n` synthetic `cargo clippy --message-format=json` diagnostic lines, one
 *  per source line 1..n, each with a `titleLen`-byte padding tail so the
 *  serialized section's total size is controllable. Sorted input order
 *  (ascending line, ascending title) matches gather's own trim sort key
 *  (path, then line, then title), so the kept prefix is exactly lines 1..k. */
function clippyDiagnostics(n: number, titleLen: number): string {
  const lines: string[] = [];
  for (let i = 1; i <= n; i++) {
    const title = `finding-${String(i).padStart(3, "0")}-${"x".repeat(titleLen)}`;
    lines.push(JSON.stringify({
      reason: "compiler-message",
      message: {
        level: "warning",
        code: { code: "clippy::x" },
        message: title,
        spans: [{ is_primary: true, file_name: "src/a.rs", line_start: i, line_end: i }],
        children: [],
      },
    }));
  }
  return lines.join("\n");
}

/** The exact `Finding` shape `runClippy` (lint.ts) produces for a synthetic
 *  `clippyDiagnostics` line at index `i`: level "warning" maps to severity
 *  "minor" / category "maintainability", `rationale` duplicates `message`,
 *  `children: []` falls back to the default `suggested_fix` text. Used both
 *  to size the fixture's raw (pre-trim) payload and to pin the exact kept
 *  array — real reconstruction, not an approximation, so the byte-count
 *  guard below means what it says. */
function expectedClippyFinding(i: number, titleLen: number) {
  const title = `finding-${String(i).padStart(3, "0")}-${"x".repeat(titleLen)}`;
  return {
    severity: "minor" as const, category: "maintainability" as const,
    path: "src/a.rs", line: i,
    title, rationale: title,
    failure_scenario: "reported by cargo clippy",
    suggested_fix: "see clippy output",
    source: "clippy" as const, confidence: 1,
  };
}

// Fix 1: CAPS.clippy (16,000 bytes) was declared but never enforced — clippy
// findings went into the pack uncapped. 80 diagnostics of ~72 bytes each
// (title "finding-NNN-" + 60 padding chars) serialize to well over the cap;
// the deterministic trim (sort by path/line/title, keep whole findings until
// the byte budget is met) empirically keeps exactly 44 of them — findings
// 001-044, roughly half, verified stable across repeated runs before writing
// this assertion (see task-5-report.md "Fix round 2").
test("fixture: gather trims clippy findings to CAPS.clippy, keeping the exact expected prefix", async () => {
  const n = 80, titleLen = 60, keptCount = 44;
  const repo = manyLinesFixtureRepo(n);
  const cargo = fakeCargo(`
if [[ "$1" == "clippy" && "$2" == "--version" ]]; then exit 0; fi
if [[ "$1" == "clippy" ]]; then
cat <<'JSON'
${clippyDiagnostics(n, titleLen)}
JSON
exit 0
fi
exit 1
`);
  try {
    const p = await gather({ repo, base: "base", skipCargo: false, cargoBin: cargo });
    // Guard: the fixture's raw (untrimmed) clippy section must itself exceed
    // CAPS.clippy, or the "capped" assertion below would hold trivially.
    const rawFindings = Array.from({ length: n }, (_, i) => expectedClippyFinding(i + 1, titleLen));
    expect(Buffer.byteLength(JSON.stringify(rawFindings), "utf8")).toBeGreaterThan(CAPS.clippy);

    expect(p.budget.capped).toEqual(["clippy"]);
    const expectedKept = rawFindings.slice(0, keptCount);
    expect(p.clippy).toEqual(expectedKept);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

/**
 * A fixture with a raw diff far larger than every cap combined (~294 KB vs.
 * a 182 KB total ceiling), built from only 3 functions so the symbol section
 * stays tiny and the diff cap is the only thing under test. Each function
 * carries a huge `///` doc-comment line ahead of it — doc comments are not
 * part of the `function_item` node tree-sitter hands back (verified: with
 * this same construction at a smaller scale, the sibling/symbols section
 * never balloons), so this inflates the diff without inflating `symbols`.
 */
function hugeDiffFixtureRepo(nFns: number, docRepeat: number): string {
  const repo = mkdtempSync(join(tmpdir(), "gather-bigdiff-"));
  const sh = (c: string) => Bun.spawnSync(["bash", "-lc", c], { cwd: repo });
  sh("git init -q . && git config user.email t@t && git config user.name t");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/a.rs"), "impl T {\n    fn one() {}\n}\n");
  sh("git add -A && git commit -qm base && git branch base");
  const body = Array.from({ length: nFns }, (_, i) =>
    `    /// ${"documentation ".repeat(docRepeat)}\n` +
    `    fn f${i}(input: &str, count: usize) -> Result<String, Error> { Ok(format!("{input}{count}")) }`
  ).join("\n");
  writeFileSync(join(repo, "src/a.rs"), `impl T {\n${body}\n}\n`);
  sh("git add -A && git commit -qm change");
  return repo;
}

// Fix 2: the budget-ceiling assertion in the earlier test above (~3.3 KB
// against a 182 KB ceiling) would still pass with every cap in `gather`
// deleted — a 55x margin proves nothing. This fixture's raw diff (~294 KB)
// is itself larger than the entire ceiling, so staying under the ceiling is
// only possible because the diff cap actually fired. The load-bearing
// demonstration (cap disabled -> budget.bytes exceeds the ceiling) is a
// scratch run recorded in task-5-report.md, not part of this test.
test("fixture: gather truncates a diff far larger than every cap combined and stays under the total ceiling", async () => {
  const repo = hugeDiffFixtureRepo(3, 7000);
  try {
    const rawDiff = Bun.spawnSync(["git", "diff", "-U5", "base...HEAD", "--", "*.rs"], { cwd: repo })
      .stdout.toString();
    const total = CAPS.diff + CAPS.siblings + CAPS.clippy + CAPS.apiDelta;
    // Guard: the fixture's raw diff must itself exceed the total ceiling, or
    // "stays under the ceiling" would hold trivially even with no cap at all.
    expect(Buffer.byteLength(rawDiff, "utf8")).toBeGreaterThan(total);

    const p = await gather({ repo, base: "base", skipCargo: true });
    expect(p.budget.capped).toEqual(["diff"]);
    expect(p.budget.bytes).toBeLessThanOrEqual(total);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

/** A fixture with `n` functions in one `impl` container, zero-padded names
 *  (f00, f01, ...) so lexicographic sort order matches numeric order — this
 *  makes the deterministic trim's kept prefix easy to state and verify
 *  exactly, rather than having to reason about clippy-lint-style ordering.
 *  Declared in REVERSE (f(n-1) down to f00) source order so that source
 *  order and sorted order actively disagree: a trim that silently dropped
 *  the sort, or a comparator built the wrong way round, would keep the
 *  *last* functions in name order instead of the first, and this fixture is
 *  the only thing that would notice — see the "dropped sort" / "inverted
 *  comparator" RED-phase mutation runs in task-5-report.md. */
function manySiblingsFixtureRepo(n: number): string {
  const repo = mkdtempSync(join(tmpdir(), "gather-siblings-"));
  const sh = (c: string) => Bun.spawnSync(["bash", "-lc", c], { cwd: repo });
  sh("git init -q . && git config user.email t@t && git config user.name t");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/a.rs"), "impl T {\n    fn zzz() {}\n}\n");
  sh("git add -A && git commit -qm base && git branch base");
  const body = Array.from({ length: n }, (_, i) => {
    const idx = String(n - 1 - i).padStart(2, "0");
    return `    fn f${idx}(input: &str, count: usize) -> Result<String, Error> { Ok(format!("{input}{count}")) }`;
  }).join("\n");
  writeFileSync(join(repo, "src/a.rs"), `impl T {\n${body}\n}\n`);
  sh("git add -A && git commit -qm change");
  return repo;
}

// Fix 3: the deterministic symbol trim (index.ts:50-63) was executed by no
// test — the original fixture's 5 functions never got near the 8 KB sibling
// cap. 15 same-container functions push the serialized `symbols` section
// over CAPS.siblings; the trim empirically keeps exactly 8 of the 15 (f00
// through f07, roughly half), verified stable across repeated runs before
// writing this assertion (see task-5-report.md "Fix round 2").
test("fixture: gather trims same-container symbols to the exact kept set, deterministically", async () => {
  const repo = manySiblingsFixtureRepo(15);
  try {
    const a = await gather({ repo, base: "base", skipCargo: true });
    const b = await gather({ repo, base: "base", skipCargo: true });
    expect(a.budget.capped).toEqual(["symbols"]);
    const expectedKept = Array.from({ length: 8 }, (_, i) => `f${String(i).padStart(2, "0")}`);
    expect(a.symbols.map(s => s.name)).toEqual(expectedKept);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
