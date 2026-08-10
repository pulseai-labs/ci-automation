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
  const total = CAPS.diff + CAPS.containers + CAPS.clippy + CAPS.apiDelta;
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
    const total = CAPS.diff + CAPS.containers + CAPS.clippy + CAPS.apiDelta;
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
 *  serialized section's total size is controllable. Emitted in DESCENDING
 *  line order (n down to 1) so stdout order and gather's sorted order
 *  (path, then ascending line, then title) actively disagree — real
 *  `cargo clippy --message-format=json` interleaves diagnostics across
 *  parallel codegen units, so it is the sort, not clippy's output order,
 *  that must produce a byte-stable section. An ascending fixture would make
 *  the `.sort(...)` at index.ts a no-op and let a dropped or inverted
 *  comparator pass silently — see the Fix 1 RED-phase mutation runs in
 *  task-5-report.md's "Fix round 3". The sorted (kept) prefix is still
 *  lines 1..k regardless of emission order. */
function clippyDiagnostics(n: number, titleLen: number): string {
  const lines: string[] = [];
  for (let i = n; i >= 1; i--) {
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
    // The invariant the snapshot above exists to demonstrate: the kept
    // section actually fits the cap. Survives future changes to Finding's
    // shape, which would otherwise silently invalidate the hardcoded 44.
    expect(Buffer.byteLength(JSON.stringify(p.clippy), "utf8")).toBeLessThanOrEqual(CAPS.clippy);
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
    const total = CAPS.diff + CAPS.containers + CAPS.clippy + CAPS.apiDelta;
    // Guard: the fixture's raw diff must itself exceed the total ceiling, or
    // "stays under the ceiling" would hold trivially even with no cap at all.
    expect(Buffer.byteLength(rawDiff, "utf8")).toBeGreaterThan(total);

    const p = await gather({ repo, base: "base", skipCargo: true });
    expect(p.budget.capped).toEqual(["diff"]);
    expect(p.budget.bytes).toBeLessThanOrEqual(total);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

/**
 * S1 (re-key sibling signatures by container): a fixture with `m` `impl`
 * containers, zero-padded labels (C00, C01, ...) so lexicographic sort order
 * matches numeric order — this makes the deterministic trim's kept set easy
 * to state and verify exactly. One container, at `bigIdx`, holds far more
 * functions than the rest, making it too large to fit once the smaller
 * containers ahead of it in sort order have already been kept.
 *
 * Containers are declared in REVERSE (C(m-1) down to C00) source order so
 * that source order and sorted order actively disagree: a trim that
 * silently dropped the sort, or a comparator built the wrong way round,
 * would keep the *last* containers in label order instead of the first, and
 * this fixture is the only thing that would notice — see the "dropped
 * sort" RED-phase mutation run in task-s1-report.md. The oversized
 * container sitting in the MIDDLE of sorted order (not at the end) is what
 * makes `continue`-vs-`break` observable: a `break` mutation would stop the
 * whole trim at the oversized container and never even consider the
 * smaller, later-sorted containers that follow it and do fit.
 *
 * `bigIdx` out of range (e.g. `-1`) means no container is oversized — every
 * one of the `m` containers gets `smallItems` functions and `bigItems` is
 * unused.
 */
function manyContainersFixtureRepo(m: number, bigIdx: number, smallItems: number, bigItems: number): string {
  const repo = mkdtempSync(join(tmpdir(), "gather-containers-"));
  const sh = (c: string) => Bun.spawnSync(["bash", "-lc", c], { cwd: repo });
  sh("git init -q . && git config user.email t@t && git config user.name t");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/a.rs"), "impl Placeholder {\n    fn zzz() {}\n}\n");
  sh("git add -A && git commit -qm base && git branch base");
  const blocks: string[] = [];
  for (let idx = m - 1; idx >= 0; idx--) {
    const label = `C${String(idx).padStart(2, "0")}`;
    const n = idx === bigIdx ? bigItems : smallItems;
    const fns = Array.from({ length: n }, (_, j) =>
      `    fn f${String(idx).padStart(2, "0")}_${j}(input: &str, count: usize) -> Result<String, Error> { Ok(format!("{input}{count}")) }`
    ).join("\n");
    blocks.push(`impl ${label} {\n${fns}\n}`);
  }
  writeFileSync(join(repo, "src/a.rs"), blocks.join("\n\n") + "\n");
  sh("git add -A && git commit -qm change");
  return repo;
}

// S1: the old symbol-level trim (index.ts, pre-S1) was executed by a fixture
// with 15 functions in a SINGLE container — meaningless once the cap moved
// to `containers`, since a single container is either kept whole or dropped
// whole; there is nothing to trim "the exact kept set" from. This replaces
// it with 15 containers (C00-C14); C05 holds 110 functions (~6.6 KB alone)
// and does not fit once C00-C04 are already kept, but C06-C14 (small) are
// tried afterward and DO fit — kept = C00-C04, C06-C14 (14 of 15, dropping
// only C05). Numbers verified against the real `gather()` pipeline before
// writing this assertion (see task-s1-report.md).
test("fixture: gather trims whole containers to CAPS.containers, keeping the exact expected set", async () => {
  const repo = manyContainersFixtureRepo(15, 5, 3, 110);
  try {
    const a = await gather({ repo, base: "base", skipCargo: true });
    const b = await gather({ repo, base: "base", skipCargo: true });
    expect(a.budget.capped).toEqual(["containers"]);
    const expectedKept = [
      ...Array.from({ length: 5 }, (_, i) => `C${String(i).padStart(2, "0")}`), // C00-C04
      ...Array.from({ length: 9 }, (_, i) => `C${String(i + 6).padStart(2, "0")}`), // C06-C14
    ].map(label => `impl ${label}`);
    expect(a.containers.map(c => c.container)).toEqual(expectedKept);
    // never split a container's signatures — every kept container has all
    // of its own items (3, since only C05 is the 110-item outlier)
    expect(a.containers.every(c => c.signatures.length === 3)).toBe(true);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // The invariant the snapshot above exists to demonstrate: the kept
    // section actually fits the cap.
    expect(Buffer.byteLength(JSON.stringify(a.containers), "utf8")).toBeLessThanOrEqual(CAPS.containers);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// S1: `trimToCap`'s separator-byte accounting is load-bearing, not
// decorative — and, being shared by both call sites (F3's whole point),
// this exercises it via the clippy path, whose synthetic JSON diagnostics
// give byte-exact control that hand-written Rust source doesn't. 47
// same-size findings serialize to just 19 bytes over CAPS.clippy; the
// correct trim keeps 46 (findings 001-046). A version that stopped counting
// the ',' separating each kept element (the "dropping the separator
// accounting" mutation named in task-s1-brief.md) would let all 47 through
// — its own internal byte count under-shoots by exactly the number of
// separators it failed to add — so the resulting section would silently
// exceed the cap it claims to enforce (real bytes 16,019 > CAPS.clippy
// 16,000; see task-s1-report.md's mutation run for the actual number). The
// pre-existing "keeping the exact expected prefix" test above (n=80,
// titleLen=60) does NOT catch this same mutation — verified empirically,
// not just asserted: its kept count (44) is unchanged whether the separator
// byte is counted or not, because item 45 (the first excluded one) is far
// larger than the up-to-43 stray bytes a dropped separator could free up.
// 47/49 here was found by search specifically because its boundary IS that
// tight (see task-s1-report.md).
test("fixture: gather's clippy trim accounts for the JSON separator byte, not just each finding's own size", async () => {
  const n = 47, titleLen = 49, keptCount = 46;
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
    const rawFindings = Array.from({ length: n }, (_, i) => expectedClippyFinding(i + 1, titleLen));
    // Guard: the raw (untrimmed) section must itself exceed CAPS.clippy by
    // less than one finding's worth of separator bytes, or this fixture
    // would not be distinguishing "counts separators" from "doesn't".
    const rawBytes = Buffer.byteLength(JSON.stringify(rawFindings), "utf8");
    expect(rawBytes).toBeGreaterThan(CAPS.clippy);

    expect(p.budget.capped).toEqual(["clippy"]);
    const expectedKept = rawFindings.slice(0, keptCount);
    expect(p.clippy).toEqual(expectedKept);
    // The invariant a dropped separator byte would violate: the kept
    // section must actually fit inside the declared cap.
    expect(Buffer.byteLength(JSON.stringify(p.clippy), "utf8")).toBeLessThanOrEqual(CAPS.clippy);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// S1: the regression this whole task exists to prevent (task-s1-brief.md,
// "The problem, measured"). Before S1, `SymbolInfo.siblings` copied the
// WHOLE container's signature list onto every touched symbol in it, making
// the section O(symbols × container size). 3 containers (M) with 30 touched
// functions each (N=90 symbols, N ≫ M) exercise that shape directly: the
// serialized `containers` section must be proportional to M (each
// container's list stored once), not to N (which is what copying it onto
// every one of the 90 symbols would have produced). The comparison is a
// real reconstruction of the pre-S1 per-symbol-duplicated shape from the
// same extracted data, not an approximated number.
test("fixture: containers bytes scale with the number of containers, not the number of symbols in them", async () => {
  const M = 3, k = 30;
  const repo = manyContainersFixtureRepo(M, -1, k, k);
  try {
    const p = await gather({ repo, base: "base", skipCargo: true });
    const N = M * k;
    expect(p.symbols.length).toBe(N);
    // one entry per container, NOT one per symbol
    expect(p.containers.length).toBe(M);
    expect(p.budget.capped).not.toContain("containers");

    const containersBytes = Buffer.byteLength(JSON.stringify(p.containers), "utf8");

    // Reconstruct what the pre-S1 `siblings` shape (one full copy of the
    // container's signature list, self excluded, PER touched symbol) would
    // have serialized to, from the same real extracted data.
    const oldStyle = p.symbols.map(s => {
      const c = p.containers.find(c => c.path === s.path && c.container === s.container)!;
      return {
        path: s.path, name: s.name, kind: s.kind, container: s.container,
        siblings: c.signatures.filter(sig => !sig.startsWith(`fn ${s.name}(`)),
      };
    });
    const oldStyleBytes = Buffer.byteLength(JSON.stringify(oldStyle), "utf8");

    // New (stored once per container) must be a small fraction of what the
    // old (stored once per symbol) shape would have cost — proportional to
    // M rather than N. Threshold set well inside the ~29x margin measured
    // for these exact numbers (see task-s1-report.md), so it stays
    // sensitive to a real regression without being flaky.
    expect(containersBytes * 10).toBeLessThan(oldStyleBytes);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
