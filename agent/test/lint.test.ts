import { test, expect } from "bun:test";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClippy } from "../src/stage1/lint";
import { runApiDelta, runSemverChecks } from "../src/stage1/cargoTools";

// --- test helpers ------------------------------------------------------

/** Writes an executable stand-in "cargo" and returns its absolute path.
 *  `body` receives $1, $2, ... exactly as the real cargo invocations pass
 *  them (`<sub> --version` for a `have()` probe, `<sub> <flags...>` for the
 *  real call), so a script can branch on `$1`/`$2` to fake both. */
function fakeCargo(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-cargo-"));
  const path = join(dir, "cargo");
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A git repo with `content` committed on branch "base", then a second
 *  commit on the current branch applying `mutate`. Mirrors symbols.test.ts's
 *  repoWith helper. */
function repoWith(content: string, mutate: (c: string) => string): string {
  const repo = mkdtempSync(join(tmpdir(), "lint-repo-"));
  const sh = (c: string) => Bun.spawnSync(["bash", "-lc", c], { cwd: repo });
  sh("git init -q . && git config user.email t@t && git config user.name t");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/db.rs"), content);
  sh("git add -A && git commit -qm base && git branch base");
  writeFileSync(join(repo, "src/db.rs"), mutate(content));
  sh("git add -A && git commit -qm change");
  return repo;
}

// --- pre-existing tests (brief step 1), updated for runClippy(repo, base, files, opts) ---

test("runClippy degrades cleanly when cargo is absent", () => {
  const r = runClippy("/nonexistent-repo", "main", [], { cargoBin: "definitely-not-cargo" });
  expect(r.findings).toEqual([]);
  expect(r.degraded.join(" ")).toContain("clippy");
});

test("runApiDelta degrades cleanly when the tool is absent", () => {
  const r = runApiDelta("/nonexistent-repo", "main", { cargoBin: "definitely-not-cargo" });
  expect(r.apiDelta).toBeUndefined();
  expect(r.degraded.join(" ")).toContain("public-api");
});

test("runSemverChecks degrades cleanly when the tool is absent", () => {
  const r = runSemverChecks("/nonexistent-repo", { cargoBin: "definitely-not-cargo" });
  expect(r.semver).toBeUndefined();
  expect(r.degraded.join(" ")).toContain("semver");
});

// --- Important finding 1: clippy scoped to changed LINES, not changed files ---

const TEN_LINES = ["fn a() {}", "fn b() {}", "fn c() {}", "fn d() {}", "fn e() {}",
  "fn f() {}", "fn g() {}", "fn h() {}", "fn i() {}", "fn j() {}", ""].join("\n");

test("runClippy keeps only diagnostics whose span overlaps a changed line, not merely a changed file", () => {
  const repo = repoWith(TEN_LINES, s => s.replace("fn c() {}", "fn c2() {}")); // changes line 3
  const cargo = fakeCargo(`
if [[ "$1" == "clippy" && "$2" == "--version" ]]; then
  exit 0
fi
cat <<'JSON'
{"reason":"compiler-message","message":{"level":"warning","code":{"code":"clippy::x"},"message":"on-changed-line","spans":[{"is_primary":true,"file_name":"src/db.rs","line_start":3,"line_end":3}],"children":[]}}
{"reason":"compiler-message","message":{"level":"warning","code":{"code":"clippy::x"},"message":"far-from-change","spans":[{"is_primary":true,"file_name":"src/db.rs","line_start":9,"line_end":9}],"children":[]}}
{"reason":"compiler-message","message":{"level":"warning","code":{"code":"clippy::x"},"message":"overlapping-span","spans":[{"is_primary":true,"file_name":"src/db.rs","line_start":2,"line_end":4}],"children":[]}}
JSON
exit 0
`);

  const r = runClippy(repo, "base", [{ path: "src/db.rs", added: 1, removed: 1 }], { cargoBin: cargo });
  const titles = r.findings.map(f => f.title);

  // exact match on the changed line: kept
  expect(titles).toContain("on-changed-line");
  // span [2,4] never equals the changed row (3) exactly, but overlaps it: kept
  // — this is the documented policy (hunks.ts rangeTouched): overlap, not exact match.
  expect(titles).toContain("overlapping-span");
  // same file, but its span (line 9) touches nothing the diff changed: dropped
  expect(titles).not.toContain("far-from-change");
  expect(r.findings.length).toBe(2);

  rmSync(repo, { recursive: true, force: true });
});

// --- Important finding 2: a broken semver invocation must degrade, not fabricate a Finding ---

test("runSemverChecks degrades (does not fabricate a Finding) when the tool ran but produced no report", () => {
  const cargo = fakeCargo(`
if [[ "$1" == "semver-checks" && "$2" == "--version" ]]; then
  exit 0
fi
if [[ "$1" == "semver-checks" && "$2" == "check-release" ]]; then
  echo "error: no crates.io baseline found for this crate" 1>&2
  exit 1
fi
exit 1
`);
  const r = runSemverChecks("/tmp", { cargoBin: cargo });
  // "ran, failed" must land in degraded as undefined -- never as a synthesized
  // major/api-contract Finding for a check that never validly compared anything.
  expect(r.semver).toBeUndefined();
  expect(r.degraded.join(" ")).toContain("semver-checks");
  // the real failure reason (stderr) must actually be surfaced, not dropped
  expect(r.degraded.join(" ")).toContain("no crates.io baseline");
});

test("runSemverChecks still reports a real breaking change when the tool produces a report", () => {
  const cargo = fakeCargo(`
if [[ "$1" == "semver-checks" && "$2" == "--version" ]]; then
  exit 0
fi
if [[ "$1" == "semver-checks" && "$2" == "check-release" ]]; then
  echo "--- failure major: removed function 'pub_fn' ---"
  exit 1
fi
exit 1
`);
  const r = runSemverChecks("/tmp", { cargoBin: cargo });
  expect(r.semver?.length).toBe(1);
  // the finding must carry a non-empty rationale drawn from the report
  expect(r.semver?.[0]?.rationale).toContain("removed function");
});

// --- Important finding 3: guard real invocations against a spawn-level throw ---
// Bun.spawnSync throws synchronously (not a non-zero result) when the process
// cannot be started at all -- empirically reproduced here with a nonexistent
// cwd, the reviewer's own repro. `have()` cannot catch this: it never spawns
// with `cwd: repo`, so a bad *repo* cwd only ever surfaces at the real call.

const BAD_CWD = "/definitely/does/not/exist/nope";

test("runClippy guards a spawn-level throw (bad cwd) and degrades instead of throwing", () => {
  const r = runClippy(BAD_CWD, "main", [], { cargoBin: "true" });
  expect(r.findings).toEqual([]);
  expect(r.degraded.length).toBeGreaterThan(0);
});

test("runApiDelta guards a spawn-level throw (bad cwd) and degrades instead of throwing", () => {
  const r = runApiDelta(BAD_CWD, "main", { cargoBin: "true" });
  expect(r.apiDelta).toBeUndefined();
  expect(r.degraded.length).toBeGreaterThan(0);
});

test("runSemverChecks guards a spawn-level throw (bad cwd) and degrades instead of throwing", () => {
  const r = runSemverChecks(BAD_CWD, { cargoBin: "true" });
  expect(r.semver).toBeUndefined();
  expect(r.degraded.length).toBeGreaterThan(0);
});

// --- Important finding 4: consolidated have() gives runClippy an accurate ---
// --- degrade message for "component missing" vs. "build failed"          ---

test("runClippy distinguishes a missing clippy component from a real build failure", () => {
  const missingComponent = fakeCargo(`
if [[ "$2" == "--version" ]]; then
  exit 1
fi
exit 1
`);
  const componentResult = runClippy("/tmp", "main", [], { cargoBin: missingComponent });
  expect(componentResult.degraded.join(" ")).toContain("component");
  expect(componentResult.degraded.join(" ")).not.toContain("build failed");

  const buildFailure = fakeCargo(`
if [[ "$2" == "--version" ]]; then
  exit 0
fi
echo "error: could not compile probe due to 1 previous error" 1>&2
exit 101
`);
  const buildResult = runClippy("/tmp", "main", [], { cargoBin: buildFailure });
  expect(buildResult.degraded.join(" ")).toContain("build failed");
});

// --- category mapping based on lint level ---

test("runClippy maps error-level diagnostics to correctness and warning-level to maintainability", () => {
  const repo = repoWith(TEN_LINES, s => s.replace("fn a() {}", "fn a2() {}"));
  const cargo = fakeCargo(`
if [[ "$1" == "clippy" && "$2" == "--version" ]]; then
  exit 0
fi
cat <<'JSON'
{"reason":"compiler-message","message":{"level":"error","code":{"code":"clippy::eq_op"},"message":"correctness-lint","spans":[{"is_primary":true,"file_name":"src/db.rs","line_start":1,"line_end":1}],"children":[]}}
{"reason":"compiler-message","message":{"level":"warning","code":{"code":"clippy::needless_return"},"message":"style-lint","spans":[{"is_primary":true,"file_name":"src/db.rs","line_start":1,"line_end":1}],"children":[]}}
JSON
exit 0
`);

  const r = runClippy(repo, "base", [{ path: "src/db.rs", added: 1, removed: 1 }], { cargoBin: cargo });
  expect(r.findings.length).toBe(2);

  const correctness = r.findings.find(f => f.title === "correctness-lint");
  expect(correctness?.category).toBe("correctness");

  const maintainability = r.findings.find(f => f.title === "style-lint");
  expect(maintainability?.category).toBe("maintainability");

  rmSync(repo, { recursive: true, force: true });
});
