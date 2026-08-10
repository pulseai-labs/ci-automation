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
  expect(existsSync(join(out, "report.md"))).toBe(true);
  expect(readFileSync(join(out, "report.md"), "utf8")).toContain("VERDICT: ERROR");

  rmSync(out, { recursive: true, force: true });
});
