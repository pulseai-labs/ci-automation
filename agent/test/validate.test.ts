import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate } from "../src/stage3/validate";
import { deriveVerdict } from "../src/stage3/verdict";
import type { Finding, EvidencePack } from "../src/types";

function f(over: Partial<Finding> = {}): Finding {
  return {
    severity: "major", category: "correctness",
    path: "src/a.rs", line: 2, title: "t", rationale: "r",
    failure_scenario: "s", suggested_fix: "x",
    source: "agent", confidence: 0.9, ...over,
  };
}

const repo = mkdtempSync(join(tmpdir(), "val-"));
mkdirSync(join(repo, "src"));
writeFileSync(join(repo, "src/a.rs"), "one\ntwo\nthree\n");
// C1: cargoTools.ts pins every semver finding to "Cargo.toml:1" — a real
// file must exist at that path for validate()'s filesystem checks.
writeFileSync(join(repo, "Cargo.toml"), "[package]\nname = \"x\"\n");

// Real `git diff -U5 base...HEAD -- '*.rs'` output (the exact command
// agent/src/stage1/diff.ts:48 runs) for: 3-line file src/a.rs, line 2
// changed "two" -> "TWO", committed on top of a base commit with the
// original 3 lines. Captured from a throwaway repo and transcribed
// verbatim (blob SHA1s are content-derived and therefore stable) —
// see Fix 2: a hand-written `@@ -2,1 +2,1 @@` hunk (zero context) hides
// the Fix 1 defect, since real -U5 output on a short file pulls the
// *whole file* into one hunk as context.
const REAL_DIFF = `diff --git a/src/a.rs b/src/a.rs
index 4cb29ea..ddc897f 100644
--- a/src/a.rs
+++ b/src/a.rs
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`;

const pack: EvidencePack = {
  head: "0".repeat(40),
  diff: REAL_DIFF,
  changed: [{ path: "src/a.rs", added: 1, removed: 1 }],
  symbols: [], containers: [], clippy: [], budget: { bytes: 0, capped: [] }, degraded: [],
};

const tmpRepos = [repo];

afterAll(() => {
  for (const dir of tmpRepos) rmSync(dir, { recursive: true, force: true });
});

// --- schema drift: an off-enum severity/category must not fail open ---

// An off-enum severity falls straight through deriveVerdict's
// `gateOn.includes(f.severity)` to `false` — a gate that fails OPEN rather
// than closed on schema drift. validate() is the only chokepoint every
// finding passes through regardless of origin, so it is the right place to
// catch this.
test("drops a finding with an off-enum severity", () => {
  const bad = f({ severity: "critical" as Finding["severity"] });
  const r = validate([bad], pack, repo);
  expect(r.kept).toEqual([]);
  expect(r.dropped).toEqual([
    { finding: bad, why: "invalid severity: critical", code: "invalid-severity" },
  ]);
});

test("drops a finding with an off-enum category", () => {
  const bad = f({ category: "style" as Finding["category"] });
  const r = validate([bad], pack, repo);
  expect(r.kept).toEqual([]);
  expect(r.dropped).toEqual([
    { finding: bad, why: "invalid category: style", code: "invalid-category" },
  ]);
});

test("drops a finding citing a nonexistent file", () => {
  const r = validate([f({ path: "src/ghost.rs" })], pack, repo);
  expect(r.kept).toEqual([]);
  expect(r.dropped).toEqual([
    { finding: f({ path: "src/ghost.rs" }), why: "path does not exist at head: src/ghost.rs", code: "path-missing" },
  ]);
});

test("drops a finding citing a line past end of file", () => {
  const r = validate([f({ line: 99999 })], pack, repo);
  expect(r.kept).toEqual([]);
  expect(r.dropped).toEqual([
    { finding: f({ line: 99999 }), why: "line 99999 outside src/a.rs (3 lines)", code: "line-out-of-range" },
  ]);
});

// Fix 3 boundary tests. `src/a.rs` has exactly 3 real lines (the trailing
// newline must not be counted as a 4th, phantom line).
test("drops a finding one line past the last valid line", () => {
  const r = validate([f({ line: 4 })], pack, repo);
  expect(r.kept).toEqual([]);
  expect(r.dropped).toEqual([
    { finding: f({ line: 4 }), why: "line 4 outside src/a.rs (3 lines)", code: "line-out-of-range" },
  ]);
});

test("drops a finding at line 0", () => {
  const r = validate([f({ line: 0 })], pack, repo);
  expect(r.kept).toEqual([]);
  expect(r.dropped).toEqual([
    { finding: f({ line: 0 }), why: "line 0 outside src/a.rs (3 lines)", code: "line-out-of-range" },
  ]);
});

test("drops a finding at a negative line", () => {
  const r = validate([f({ line: -1 })], pack, repo);
  expect(r.kept).toEqual([]);
  expect(r.dropped).toEqual([
    { finding: f({ line: -1 }), why: "line -1 outside src/a.rs (3 lines)", code: "line-out-of-range" },
  ]);
});

// In REAL_DIFF, line 2 ("two" -> "TWO") is the only line the diff actually
// touches — lines 1 and 3 are -U5 context. This is the case that a
// hand-written zero-context fixture cannot exercise (Fix 1 / Fix 2).
test("keeps an in-diff finding and does not mark it adjacent", () => {
  const r = validate([f({ line: 2 })], pack, repo);
  expect(r.dropped).toEqual([]);
  expect(r.kept).toEqual([{ ...f({ line: 2 }), adjacent: false }]);
});

// Line 3 is in-bounds (it is `src/a.rs`'s last real line — this doubles as
// the Fix 3 "at exactly `lines`" boundary case) but is -U5 *context*, not a
// changed line. Under the pre-fix `diffLines`, which blindly expanded the
// hunk header's declared range instead of walking the body, this line would
// have been wrongly marked touched (the header says `+1,3`, so old code
// touched 1, 2, AND 3) and this assertion would fail.
test("keeps an out-of-diff finding but marks it adjacent", () => {
  const r = validate([f({ line: 3 })], pack, repo);
  expect(r.dropped).toEqual([]);
  expect(r.kept).toEqual([{ ...f({ line: 3 }), adjacent: true }]);
});

// --- C1: stage 3 must not re-decide adjacency for a deterministic finding ---

// diff.ts:48 scopes `git diff` to `-- '*.rs'` — Cargo.toml can NEVER be a
// key in `touched`, so a validate() that re-decides adjacency for every
// finding (not just agent ones) marks every semver finding `adjacent: true`
// unconditionally, permanently defeating verdict.ts's api-contract gate.
test("C1: a semver finding on Cargo.toml is never re-decided as adjacent by the diff's touched-line map", () => {
  const semverFinding = f({
    source: "semver", severity: "major", category: "api-contract",
    path: "Cargo.toml", line: 1, title: "cargo semver-checks reported a breaking change",
  });
  const r = validate([semverFinding], pack, repo);
  expect(r.dropped).toEqual([]);
  expect(r.kept).toEqual([{ ...semverFinding, adjacent: false }]);
});

// In REAL_DIFF, src/a.rs line 1 is -U5 CONTEXT, not a changed line (only
// line 2 is). lint.ts deliberately keeps a clippy diagnostic whose SPAN
// overlaps a changed row even when `span.line_start` itself lands on a
// context line, and reports `line: span.line_start` — a validate() that
// re-decides adjacency for clippy findings undoes that correct upstream
// decision and downgrades the finding to non-gating.
test("C1: a clippy finding whose reported line is diff context (not itself a changed line) is never marked adjacent", () => {
  const clippyFinding = f({
    source: "clippy", severity: "major", category: "correctness",
    path: "src/a.rs", line: 1,
  });
  const r = validate([clippyFinding], pack, repo);
  expect(r.dropped).toEqual([]);
  expect(r.kept).toEqual([{ ...clippyFinding, adjacent: false }]);
});

// Both findings above must not merely come back `adjacent: false` from
// validate() in isolation — they must actually gate the merge once fed
// through deriveVerdict(), which is the whole point of C1.
test("C1: both the semver and clippy findings above gate the merge (FAIL)", () => {
  const semverFinding = f({
    source: "semver", severity: "major", category: "api-contract",
    path: "Cargo.toml", line: 1,
  });
  const clippyFinding = f({
    source: "clippy", severity: "major", category: "correctness",
    path: "src/a.rs", line: 1,
  });
  const { kept, dropped } = validate([semverFinding, clippyFinding], pack, repo);
  expect(dropped).toEqual([]);
  const v = deriveVerdict(kept, pack);
  expect(v.verdict).toBe("FAIL");
  expect(v.reason).toBe("2 gating finding(s), highest severity major");
});

// --- C1: normalize the lookup key before checking diff adjacency ---

// A model emitting an equivalent but differently-spelled path (here,
// "./src/a.rs" for a diff whose canonical spelling is "src/a.rs") must not
// silently miss `touched` (keyed by the diff's own spelling) and come back
// `adjacent: true` — the same silent gate downgrade C1 fixes for
// source-based mismatches. The kept finding's stored `path` is the
// normalized, repo-relative POSIX spelling too, not the raw model input.
test("C1: normalizes an equivalent but differently-spelled path before checking diff adjacency", () => {
  const r = validate([f({ path: "./src/a.rs", line: 2 })], pack, repo);
  expect(r.dropped).toEqual([]);
  expect(r.kept).toEqual([{ ...f({ path: "./src/a.rs", line: 2 }), path: "src/a.rs", adjacent: false }]);
});

// --- N1: normalize BEFORE keying, not just before the adjacency lookup ---

// Two spellings of the identical finding ("src/a.rs" and "./src/a.rs")
// must collapse to ONE kept finding with a recorded "duplicate" drop — not
// two gating findings at the same rendered location with nothing in
// `dropped` to explain it. Before N1, `key()` (used by both the
// deterministic-dedupe check and the same-list `seen` dedupe) was keyed on
// the raw, unnormalized `f.path`, so the two spellings produced two
// different keys and both survived into `kept` — a fail-OPEN double count.
test("N1: two differently-spelled paths for the identical finding dedupe to one kept finding", () => {
  const spelledPlain = f({ path: "src/a.rs", line: 2, title: "the-finding" });
  const spelledDotSlash = f({ path: "./src/a.rs", line: 2, title: "the-same-finding" });
  const r = validate([spelledPlain, spelledDotSlash], pack, repo);
  expect(r.kept).toEqual([{ ...spelledPlain, adjacent: false }]);
  expect(r.dropped).toEqual([
    { finding: spelledDotSlash, why: "duplicate finding", code: "duplicate" },
  ]);
});

// The same normalize-before-key gap also let an agent finding spelled
// "./src/a.rs" slip past the duplicate-of-deterministic check against a
// clippy finding spelled "src/a.rs" — `deterministicKeys` (built from
// `pack.clippy`/`pack.semver`) was keyed on THEIR raw paths too.
test("N1: an agent finding spelled './src/a.rs' dedupes against a clippy finding spelled 'src/a.rs'", () => {
  const clippyFinding = f({ source: "clippy", path: "src/a.rs", line: 2 });
  const withClippy: EvidencePack = { ...pack, clippy: [clippyFinding] };
  const agentFinding = f({ source: "agent", path: "./src/a.rs", line: 2 });
  const r = validate([agentFinding], withClippy, repo);
  expect(r.kept).toEqual([]);
  expect(r.dropped).toEqual([
    { finding: agentFinding, why: "duplicate of a deterministic finding", code: "duplicate-of-deterministic" },
  ]);
});

test("dedupes an agent finding against an identical clippy finding", () => {
  const withClippy: EvidencePack = { ...pack, clippy: [f({ source: "clippy" })] };
  const r = validate([f({ source: "agent" })], withClippy, repo);
  expect(r.kept).toEqual([]);
  expect(r.dropped).toEqual([
    { finding: f({ source: "agent" }), why: "duplicate of a deterministic finding", code: "duplicate-of-deterministic" },
  ]);
});

test("a clippy finding survives validate — it is not a duplicate of itself", () => {
  const clippy = f({ source: "clippy", line: 2, title: "clippy lint" });
  const withClippy: EvidencePack = { ...pack, clippy: [clippy] };
  // exactly what stage 3's finalize() will pass: agent findings AND the
  // deterministic ones, in one list
  const r = validate([clippy], withClippy, repo);
  expect(r.dropped).toEqual([]);
  expect(r.kept).toEqual([{ ...clippy, adjacent: false }]);
});

// The generic same-list dedupe (`seen`) is a separate code path from the
// agent-vs-deterministic dedupe above: no clippy/semver finding involved,
// just two identical findings in one call.
test("dedupes two identical agent findings with no deterministic match", () => {
  const first = f({ line: 2 });
  const second = f({ line: 2 });
  const r = validate([first, second], pack, repo);
  expect(r.kept).toEqual([{ ...first, adjacent: false }]);
  expect(r.dropped).toEqual([{ finding: second, why: "duplicate finding", code: "duplicate" }]);
});

// Fix 4: a model-supplied path must not escape the repo root.
test("drops a finding whose path escapes the repo", () => {
  const escapee = "../".repeat(20) + "etc/passwd";
  const r = validate([f({ path: escapee })], pack, repo);
  expect(r.kept).toEqual([]);
  expect(r.dropped).toEqual([
    { finding: f({ path: escapee }), why: `path escapes repo: ${escapee}`, code: "path-escapes-repo" },
  ]);
});

// Fix 4: a directory that happens to exist at the given path must be
// rejected, not passed to readFileSync (which throws EISDIR and would take
// down the whole validate() call — and, via runReview, the merge gate).
test("drops a finding whose path is a directory, not a regular file", () => {
  const r = validate([f({ path: "src" })], pack, repo);
  expect(r.kept).toEqual([]);
  expect(r.dropped).toEqual([
    { finding: f({ path: "src" }), why: "path is not a regular file: src", code: "not-a-regular-file" },
  ]);
});

// Fix 1: diffLines must tolerate a diff cut off mid-hunk by stage 1's byte
// cap (agent/src/stage1/diff.ts's `cap()`), never throw, and must not count
// anything past the cut.
test("does not throw on a diff truncated mid-hunk", () => {
  const truncated = REAL_DIFF.slice(0, REAL_DIFF.indexOf("+TWO") + 2); // cuts inside "+TWO"
  const truncatedPack: EvidencePack = { ...pack, diff: truncated };
  expect(() => validate([f({ line: 1 })], truncatedPack, repo)).not.toThrow();
  const r = validate([f({ line: 1 })], truncatedPack, repo);
  // line 1 ("one") is a context line before the cut — still counted.
  expect(r.dropped).toEqual([]);
  expect(r.kept).toEqual([{ ...f({ line: 1 }), adjacent: true }]);
});

// Fix 2: a count-less hunk header (`@@ -N +N @@`, git's shorthand for a
// single-line hunk on both sides) must still register its line as touched.
// This is real `git diff -U5` output for a 1-line file whose only line
// changed — a file too short for -U5 to ever produce a comma-count.
const countlessRepo = mktmpRepoWithFile("src/b.rs", "ONLY\n");
const COUNTLESS_DIFF = `diff --git a/src/b.rs b/src/b.rs
index 6c542ab..bc8c7b4 100644
--- a/src/b.rs
+++ b/src/b.rs
@@ -1 +1 @@
-only
+ONLY
`;
const countlessPack: EvidencePack = {
  head: "0".repeat(40),
  diff: COUNTLESS_DIFF,
  changed: [{ path: "src/b.rs", added: 1, removed: 1 }],
  symbols: [], containers: [], clippy: [], budget: { bytes: 0, capped: [] }, degraded: [],
};

test("registers a count-less hunk header's line as touched", () => {
  const r = validate([f({ path: "src/b.rs", line: 1 })], countlessPack, countlessRepo);
  expect(r.dropped).toEqual([]);
  expect(r.kept).toEqual([{ ...f({ path: "src/b.rs", line: 1 }), adjacent: false }]);
});

// Fix 5: a hunk BODY line that itself renders as "+++ b/decoy.rs" (i.e. the
// added source content is literally "++ b/decoy.rs" — not valid Rust at top
// level, but legal inside a comment or raw string) must not re-point `file`
// for later hunks in the same file. Real `git diff -U5` output for a
// 30-line file: line 2 replaced with the decoy content, line 25 separately
// changed in a second hunk.
const decoyRepo = mktmpRepoWithFile(
  "src/a.rs",
  Array.from({ length: 30 }, (_, i) => {
    if (i === 1) return "++ b/decoy.rs";
    if (i === 24) return "L25";
    return `l${i + 1}`;
  }).join("\n") + "\n",
);
const DECOY_DIFF = `diff --git a/src/a.rs b/src/a.rs
index 58b8997..b62bab7 100644
--- a/src/a.rs
+++ b/src/a.rs
@@ -1,7 +1,7 @@
 l1
-l2
+++ b/decoy.rs
 l3
 l4
 l5
 l6
 l7
@@ -20,11 +20,11 @@ l19
 l20
 l21
 l22
 l23
 l24
-l25
+L25
 l26
 l27
 l28
 l29
 l30
`;
const decoyPack: EvidencePack = {
  head: "0".repeat(40),
  diff: DECOY_DIFF,
  changed: [{ path: "src/a.rs", added: 2, removed: 2 }],
  symbols: [], containers: [], clippy: [], budget: { bytes: 0, capped: [] }, degraded: [],
};

test("attributes the hunk following a +++-shaped decoy line to the real file", () => {
  const r = validate([f({ path: "src/a.rs", line: 25 })], decoyPack, decoyRepo);
  expect(r.dropped).toEqual([]);
  expect(r.kept).toEqual([{ ...f({ path: "src/a.rs", line: 25 }), adjacent: false }]);
});

function mktmpRepoWithFile(relPath: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "val-"));
  const full = join(dir, relPath);
  mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  writeFileSync(full, content);
  tmpRepos.push(dir);
  return dir;
}
