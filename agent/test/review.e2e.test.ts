import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview } from "../src/review";
import { readResult } from "../src/result";
import type { Finding, Verdict } from "../src/types";

function fixtureRepo() {
  const repo = mkdtempSync(join(tmpdir(), "e2e-"));
  const sh = (c: string) => Bun.spawnSync(["bash", "-lc", c], { cwd: repo });
  sh("git init -q . && git config user.email t@t && git config user.name t");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/a.rs"), "impl T {\n    fn one() {}\n}\n");
  sh("git add -A && git commit -qm base && git branch base");
  writeFileSync(join(repo, "src/a.rs"), "impl T {\n    fn one() { let x = 1; }\n}\n");
  sh("git add -A && git commit -qm change");
  return repo;
}

test("end to end with a stubbed stage 2 produces a report and a terminal result", async () => {
  const repo = fixtureRepo();
  const out = mkdtempSync(join(tmpdir(), "out-"));

  const stub = async (): Promise<{ findings: Finding[] }> => ({
    findings: [{
      severity: "blocker", category: "correctness", path: "src/a.rs", line: 2,
      title: "stubbed", rationale: "r", failure_scenario: "s",
      suggested_fix: "x", source: "agent", confidence: 1,
    }],
  });

  const r = await runReview({ repo, base: "base", outDir: out, skipCargo: true, reason: stub });
  expect(r.verdict).toBe("FAIL");
  expect(readResult(out).verdict).toBe("FAIL");
  expect(existsSync(join(out, "report.md"))).toBe(true);
  // Pinned per amendment A5: exact first line, not a substring match.
  const report = readFileSync(join(out, "report.md"), "utf8");
  expect(report.split("\n")[0]).toBe("## VERDICT: FAIL");

  rmSync(repo, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

test("a throwing stage 2 yields ERROR, never PASS", async () => {
  const repo = fixtureRepo();
  const out = mkdtempSync(join(tmpdir(), "out-"));
  const boom = async () => { throw new Error("provider exploded"); };

  const r = await runReview({ repo, base: "base", outDir: out, skipCargo: true, reason: boom });
  expect(r.verdict).toBe("ERROR");
  // Pinned per amendment A5: exact reason, not a substring match.
  expect(r.reason).toBe("provider exploded");
  expect(readResult(out).verdict).toBe("ERROR");

  rmSync(repo, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

// Renamed per amendment A5: the original name claimed a "keeps partial
// findings" guarantee nothing implements — the catch block hardcodes
// `findings: []` and a Promise.race against a rejecting deadline cannot
// yield partials.
test("the self-deadline produces ERROR, never PASS", async () => {
  const repo = fixtureRepo();
  const out = mkdtempSync(join(tmpdir(), "out-"));
  const slow = async () => { await Bun.sleep(500); return { findings: [] }; };

  const r = await runReview({ repo, base: "base", outDir: out, skipCargo: true,
                              reason: slow, deadlineMs: 50 });
  expect(r.verdict).toBe("ERROR");
  // Pinned per amendment A5: exact message, including the millisecond value.
  expect(r.reason).toBe("self-deadline exceeded after 50ms");

  rmSync(repo, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

// Amendment A4: observe the fail-closed ordering itself, not just the final
// value. The injected stage-2 function is the seam: it peeks at result.json
// mid-flight, before runReview's own writeResult() call has happened. A
// runReview that wrote result.json only once at the end would still satisfy
// every other test in this file identically — this is the one that would not.
test("result.json already holds a terminal verdict before stage 2 runs", async () => {
  const repo = fixtureRepo();
  const out = mkdtempSync(join(tmpdir(), "out-"));
  let midFlight: Verdict | undefined;
  let midFlightReason: string | undefined;
  const peek = async () => {
    const r = readResult(out);
    midFlight = r.verdict;
    midFlightReason = r.reason;
    return { findings: [] };
  };

  await runReview({ repo, base: "base", outDir: out, skipCargo: true, reason: peek });
  expect(midFlight).toBe("ERROR");
  // Pin the exact reason too, not just the verdict. `initResult()` writes
  // "orchestrator did not complete" (result.ts); `readResult()`'s own
  // missing-file fallback writes a different string ("result.json missing
  // at ..."). A `runReview` that skips `initResult()` and writes result.json
  // only once at the end would leave no file on disk mid-flight — and
  // `readResult()`'s fallback ALSO reports verdict "ERROR", so a
  // verdict-only assertion here cannot tell "seeded before stage 2" apart
  // from "never written yet". The reason string is what tells them apart.
  expect(midFlightReason).toBe("orchestrator did not complete");

  rmSync(repo, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

// Fix round 1, Fix 1: the fail-closed contract is "before ANY other work",
// not merely "before stage 2" — the test above only observes the seam stage
// 2 happens to provide. `gather()` itself is the long, kill-prone phase (git
// spawns, tree-sitter WASM init, cargo clippy), which is exactly the window
// the seed exists to cover, and no test in the file observed it: moving
// `initResult(o.outDir)` to run after `await gather(...)` left the entire
// suite green, because a `gather()` throw is still caught and `writeResult`
// still runs once at the very end regardless.
//
// This test needs no timing race and no hook into runReview. JS's run-to-
// first-await semantics guarantee it: `runReview` executes synchronously,
// including everything before its first `await`, before the call expression
// `runReview(...)` ever returns a promise to its caller. In the correct
// code `initResult()` is the first statement, unconditional and synchronous,
// strictly before `await gather(...)` — so by the time this test's own
// `runReview(...)` call finishes evaluating (before this test ever awaits
// it), `initResult()` has already run and result.json is already seeded on
// disk, deterministically, not probabilistically. A repo that doesn't exist
// makes `gather()` throw on its very first line (`git rev-parse HEAD`) —
// still after any `await gather(...)` would have to suspend runReview to
// propagate that failure, so the peek below is still strictly before the
// run's own terminal `writeResult()` call. Verified empirically both ways
// (see task-9-report.md, Fix round 1) before writing this test.
test("initResult seeds a terminal ERROR before gather() runs, synchronously — not just before stage 2", async () => {
  const out = mkdtempSync(join(tmpdir(), "out-"));
  const neverCalled = async (): Promise<{ findings: Finding[] }> => {
    throw new Error("stage 2 must not run when gather() itself fails");
  };

  // Deliberately not awaited yet — the peek below must happen synchronously,
  // in the same tick as this call, before any microtask from inside
  // runReview or gather() gets a chance to run.
  const pending = runReview({
    repo: "/nonexistent-path-xyz-123", base: "base", outDir: out,
    skipCargo: true, reason: neverCalled,
  });

  const peek = readResult(out);
  expect(peek.verdict).toBe("ERROR");
  expect(peek.reason).toBe("orchestrator did not complete");

  await pending;
  rmSync(out, { recursive: true, force: true });
});

// Fix round 1, Fix 3: `runReview` owns the fail-closed contract, so it must
// not depend on an unwritten caller having created outDir first. Before this
// fix, a nonexistent outDir made `initResult()` itself throw ENOENT and no
// terminal state was written anywhere — a hole at line one of the guarantee.
test("a nonexistent outDir is created so the run still reaches a terminal state on disk", async () => {
  const repo = fixtureRepo();
  const parent = mkdtempSync(join(tmpdir(), "outparent-"));
  const out = join(parent, "nested", "outdir"); // does not exist yet
  const stub = async (): Promise<{ findings: Finding[] }> => ({ findings: [] });

  const r = await runReview({ repo, base: "base", outDir: out, skipCargo: true, reason: stub });
  expect(r.verdict).toBe("PASS");
  expect(existsSync(out)).toBe(true);
  expect(readResult(out).verdict).toBe("PASS");
  expect(existsSync(join(out, "report.md"))).toBe(true);

  rmSync(repo, { recursive: true, force: true });
  rmSync(parent, { recursive: true, force: true });
});

// Fix round 1, Fix 2: amendment A2 (clear the deadline timer) had no test at
// all — removing the `finally`/`clearTimeout` left the whole suite green,
// because `bun test` force-exits and a leaked 20-minute timer is invisible
// to the runner. A leaked timer only shows up as the real-world symptom it
// causes: the OS process does not exit on its own. That is only observable
// from a real subprocess, driven end to end — an in-process assertion on
// `runReview`'s return value cannot see it, because the timer lives in the
// event loop, not in the returned value. The driver script is generated into
// its own temp dir per run, not committed as a fixture.
test("the deadline timer is cleared: a successful review lets the process exit promptly, not just runReview() resolve", async () => {
  const repo = fixtureRepo();
  const out = mkdtempSync(join(tmpdir(), "out-"));
  const driverDir = mkdtempSync(join(tmpdir(), "driver-"));
  const driverPath = join(driverDir, "driver.ts");
  const reviewPath = join(import.meta.dirname, "..", "src", "review.ts");

  writeFileSync(driverPath, `
import { runReview } from ${JSON.stringify(reviewPath)};
await runReview({
  repo: ${JSON.stringify(repo)},
  base: "base",
  outDir: ${JSON.stringify(out)},
  skipCargo: true,
  deadlineMs: 10_000,
  reason: async () => ({ findings: [] }),
});
`);

  const start = performance.now();
  const proc = Bun.spawn(["bun", driverPath], { stdout: "ignore", stderr: "pipe" });
  await proc.exited;
  const elapsedMs = performance.now() - start;

  expect(proc.exitCode).toBe(0);
  // A leaked 10s deadline timer would keep the process alive until it fires
  // (the reviewer measured this directly: `real 0.25s` cleared vs.
  // `real 30.25s` leaked, with deadlineMs: 30_000). A generous margin well
  // under the 10s deadline, but far above ordinary process/Bun-startup
  // overhead, distinguishes "exited on its own" from "exited because the
  // timer finally fired".
  expect(elapsedMs).toBeLessThan(5_000);

  rmSync(repo, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
  rmSync(driverDir, { recursive: true, force: true });
}, 15_000);

// Amendment A3: report.md must always be written, even when gather() itself
// throws and `pack` is never assigned — otherwise a human sees a red status
// with no explanation anywhere.
test("a nonexistent repo still yields a terminal ERROR and a rendered report", async () => {
  const out = mkdtempSync(join(tmpdir(), "out-"));
  const neverCalled = async (): Promise<{ findings: Finding[] }> => {
    throw new Error("stage 2 must not run when gather() itself fails");
  };

  const r = await runReview({
    repo: "/nonexistent-path-xyz-123", base: "base", outDir: out,
    skipCargo: true, reason: neverCalled,
  });

  expect(r.verdict).toBe("ERROR");
  expect(readResult(out).verdict).toBe("ERROR");
  // Fix round 1, Fix 4: every assertion above is satisfied identically
  // whether gather()'s own ENOENT or neverCalled's own error produced the
  // ERROR — this is the distinguishing check. If stage 2 ever ran despite
  // gather() failing first, `r.reason` would be neverCalled's message
  // instead of gather()'s.
  expect(r.reason).not.toContain("stage 2 must not run");
  expect(existsSync(join(out, "report.md"))).toBe(true);
  const report = readFileSync(join(out, "report.md"), "utf8");
  expect(report).toContain("VERDICT: ERROR");
  // Fix round 1, Fix 4: A3's actual purpose is that the *reason* reaches the
  // report, not merely that the verdict does — a report saying only
  // "VERDICT: ERROR" with no explanation is exactly the failure A3 exists to
  // prevent. Assert the reason text itself appears in the report body.
  expect(report).toContain(r.reason);

  rmSync(out, { recursive: true, force: true });
});

test("a diff with no .rs files short-circuits to INCONCLUSIVE without a model turn", async () => {
  const repo = mkdtempSync(join(tmpdir(), "e2e-noop-"));
  const out = mkdtempSync(join(tmpdir(), "out-"));
  const sh = (c: string) => Bun.spawnSync(["bash", "-lc", c], { cwd: repo });
  sh("git init -q . && git config user.email t@t && git config user.name t");
  mkdirSync(join(repo, ".github/workflows"), { recursive: true });
  writeFileSync(join(repo, ".github/workflows/ci.yml"), "name: CI\n");
  sh("git add -A && git commit -qm base && git branch base");
  writeFileSync(join(repo, ".github/workflows/ci.yml"), "name: CI\non: push\n");
  sh("git add -A && git commit -qm change");

  let reasonCalled = false;
  const mustNotRun = async () => { reasonCalled = true; return { findings: [] }; };

  const r = await runReview({ repo, base: "base", outDir: out, skipCargo: true, reason: mustNotRun });
  expect(r.verdict).toBe("INCONCLUSIVE");
  expect(reasonCalled).toBe(false);
  expect(readResult(out).verdict).toBe("INCONCLUSIVE");
  const report = readFileSync(join(out, "report.md"), "utf8");
  expect(report).toContain("VERDICT: INCONCLUSIVE");

  rmSync(repo, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});
