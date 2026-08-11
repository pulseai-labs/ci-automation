import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview, defaultReason } from "../src/review";

/**
 * Task 13 — the golden review: the acceptance test. The agent must re-find the
 * two known defects of PulseDB PR #66 (branch `sprint-4.3`) and record its token
 * usage for comparison against droid's measured baseline.
 *
 * This is a LIVE model turn and is non-deterministic, so it is gated behind
 * `GOLDEN=1` AND the real PulseDB checkout existing. Without `GOLDEN=1` the
 * golden test skips; only the deterministic `matches` unit tests below run.
 */

const REPO = "/Volumes/master_ssd/projects/PulseDB";
const RUN = process.env.GOLDEN === "1" && existsSync(REPO);
const maybe = RUN ? test : test.skip;

/**
 * ±25-line matcher (spec §6). True iff some finding's path ends with `path` AND
 * its line is within 25 of `near`. Exported so the matcher logic itself has a
 * deterministic, always-run unit test (the golden turn is non-deterministic,
 * but this predicate is pure and is mutation-tested below).
 *
 * The ±25 window is a hard contract: the spec pins the matcher tolerance at
 * exactly 25 lines. Do NOT widen it to make a flaky turn pass — a turn that
 * cites the wrong region is a real regression and must fail loudly.
 */
export function matches(findings: { path: string; line: number }[], path: string, near: number) {
  return findings.some((f) => f.path.endsWith(path) && Math.abs(f.line - near) <= 25);
}

// ──────────────────────────────────────────────────────────────────────────
// Deterministic, always-run unit tests for the matcher logic. These
// mutation-test the ±25 contract and the P2/P3 anchor choices so a typo or a
// loosening is caught without spending a live model turn.
// ──────────────────────────────────────────────────────────────────────────

test("matches is true inside ±25 and false outside (strict boundary)", () => {
  const f = (line: number) => [{ path: "src/db.rs", line }];
  // exact + within
  for (const d of [0, 1, 24, 25]) expect(matches(f(100 + d), "src/db.rs", 100)).toBe(true);
  for (const d of [0, 1, 24, 25]) expect(matches(f(100 - d), "src/db.rs", 100)).toBe(true);
  // one beyond the window on each side is FALSE — the boundary is exclusive at 26
  expect(matches(f(126), "src/db.rs", 100)).toBe(false);
  expect(matches(f(74), "src/db.rs", 100)).toBe(false);
});

test("matches requires the path to end with the given suffix, not just contain it", () => {
  // endsWith, so a sibling path that merely contains the substring must NOT match.
  expect(matches([{ path: "other/src/db.rs.bak", line: 100 }], "src/db.rs", 100)).toBe(false);
  expect(matches([{ path: "crates/foo/src/db.rs", line: 100 }], "src/db.rs", 100)).toBe(true);
});

test("the P2 anchors cover the real db.rs migration region and its open_with_embedder absence", () => {
  // Pin the anchors to the ACTUAL line numbers verified in the sprint-4.3 diff:
  //   - db.rs:266-280  the {builtin-onnx, main_graph} migration block in open()
  //   - db.rs:310-313  the stamp region in open() (droid's Step-0 citation)
  //   - db.rs:528-540  the mismatch arm in open_with_embedder() (the ABSENCE)
  // A model citing any of these must pass the P2 matcher.
  const anchors = [273, 310, 533];
  const realCitations = [268, 273, 280, 296, 310, 313, 528, 535, 540];
  for (const line of realCitations) {
    const ok = anchors.some((near) => matches([{ path: "src/db.rs", line }], "src/db.rs", near));
    expect(ok).toBe(true);
  }
  // A citation well outside both regions (e.g. a record_experience line) must NOT pass.
  for (const line of [900, 1500, 4000]) {
    const ok = anchors.some((near) => matches([{ path: "src/db.rs", line }], "src/db.rs", near));
    expect(ok).toBe(false);
  }
});

test("the P3 anchors cover the dead migrate_legacy_main_graph_stamp helper in onnx.rs", () => {
  // onnx.rs:323  the pub(crate) method (visible in impl OnnxEmbedding)
  // onnx.rs:681  the standalone fn
  const anchors = [323, 681];
  for (const line of [320, 323, 327, 678, 681, 690]) {
    const ok = anchors.some((near) =>
      matches([{ path: "src/embedding/onnx.rs", line }], "src/embedding/onnx.rs", near));
    expect(ok).toBe(true);
  }
  for (const line of [10, 200, 1000]) {
    const ok = anchors.some((near) =>
      matches([{ path: "src/embedding/onnx.rs", line }], "src/embedding/onnx.rs", near));
    expect(ok).toBe(false);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Content checks — a co-located finding about the WRONG issue is a false pass.
// These pin the P2/P3 assertions to the actual defect, not just a line number.
// ──────────────────────────────────────────────────────────────────────────

test("isP2Divergence accepts findings that reference the peer constructor or a migration omission", () => {
  expect(isP2Divergence({ title: "main_graph migration missing from open_with_embedder" })).toBe(true);
  expect(isP2Divergence({ rationale: "the injected embedder path lacks the migration" })).toBe(true);
  expect(isP2Divergence({ title: "legacy migration", failure_scenario: "the migration is absent from the sibling constructor" })).toBe(true);
  expect(isP2Divergence({ title: "migrate", suggested_fix: "mirror this branch in the peer" })).toBe(true);
});

test("isP2Divergence REJECTS the observed false positive: a comment-claim nit at the P2 location", () => {
  // This is the exact finding glm-5.2 emitted at db.rs:276 on the first
  // structured run — it is at the P2 location but is NOT P2. It must not pass.
  const falsePositive = {
    title: "Migration-arm comment claims 'correct even if a non-MiniLM builtin is loaded', but the condition restricts to bundled MiniLM only",
    rationale: "the comment overstates the generality of the migration branch",
  };
  expect(isP2Divergence(falsePositive)).toBe(false);
  // And a finding with no migration/peer reference at all.
  expect(isP2Divergence({ title: "unclear naming", rationale: "rename for clarity" })).toBe(false);
});

test("isDeadCode accepts dead/unused findings and rejects unrelated ones", () => {
  expect(isDeadCode({ title: "Dead migration code", rationale: "the helper is never called" })).toBe(true);
  expect(isDeadCode({ title: "unused function left behind" })).toBe(true);
  expect(isDeadCode({ title: "orphaned helper has no call site" })).toBe(true);
  expect(isDeadCode({ title: "rename for clarity" })).toBe(false);
  expect(isDeadCode({ title: "off-by-one in the loop" })).toBe(false);
});

test("the combined p2()/p3() predicates require BOTH location and content", () => {
  // A co-located comment nit (the observed false positive) must NOT pass p2().
  const commentNit = [{
    path: "src/db.rs", line: 276, severity: "nit", category: "maintainability",
    title: "Migration-arm comment claims too much", rationale: "the comment overstates generality",
  }];
  expect(p2(commentNit)).toBe(false);
  // A real P2 finding at the open migration block referencing the peer passes.
  const realP2 = [{
    path: "src/db.rs", line: 273, severity: "major", category: "correctness",
    title: "main_graph migration missing from open_with_embedder",
    rationale: "open migrates the legacy stamp; open_with_embedder refuses it as a mismatch",
  }];
  expect(p2(realP2)).toBe(true);
  // A finding about the peer that cites the open_with_embedder side passes.
  const realP2Peer = [{
    path: "src/db.rs", line: 533, severity: "major", category: "correctness",
    title: "open_with_embedder omits the legacy main_graph migration",
    rationale: "the migration branch present in open() is absent here",
  }];
  expect(p2(realP2Peer)).toBe(true);
  // A real P3 finding passes.
  const realP3 = [{
    path: "src/embedding/onnx.rs", line: 323, severity: "minor", category: "maintainability",
    title: "Dead migration helper", rationale: "never called; open() reimplements inline",
  }];
  expect(p3(realP3)).toBe(true);
  // A finding at the P3 location about something else does NOT pass.
  const notP3 = [{
    path: "src/embedding/onnx.rs", line: 323, severity: "minor", category: "correctness",
    title: "dimension check off by one", rationale: "wrong bound",
  }];
  expect(p3(notP3)).toBe(false);
});

// ──────────────────────────────────────────────────────────────────────────
// The golden review — LIVE model turn, gated on GOLDEN=1.
// ──────────────────────────────────────────────────────────────────────────

/**
 * What P2 and P3 are (the two known defects of PR #66):
 *
 * - **P2**: the `{builtin-onnx, main_graph}` legacy migration exists in `open()`
 *   (db.rs:266-280) but is MISSING from `open_with_embedder()`'s mismatch arm
 *   (db.rs:528-540). This sibling-divergence is the defect the whole feature
 *   exists to surface: a legacy store reopened via `open_with_embedder` would be
 *   refused as a mismatch instead of migrated. The changed function is `open`;
 *   the peer is `open_with_embedder`.
 *
 * - **P3**: a dead helper `migrate_legacy_main_graph_stamp` left behind in
 *   `src/embedding/onnx.rs` (the pub(crate) method at :323, delegating to the
 *   standalone fn at :681). It is `#[allow(dead_code)]` because `open()` does
 *   its migration inline rather than calling this helper.
 */

/** P2 anchors (see unit test above for why each is a genuine defect location). */
function p2Location(findings: { path: string; line: number }[]) {
  return (
    matches(findings, "src/db.rs", 273) || // open() migration block (266-280)
    matches(findings, "src/db.rs", 310) || // open() stamp region; droid's Step-0 citation
    matches(findings, "src/db.rs", 533) // open_with_embedder() mismatch arm — the absence
  );
}

/** P3 anchors — the dead helper in onnx.rs. */
function p3Location(findings: { path: string; line: number }[]) {
  return (
    matches(findings, "src/embedding/onnx.rs", 323) || // the pub(crate) method
    matches(findings, "src/embedding/onnx.rs", 681) // the standalone fn
  );
}

/**
 * Content check — makes the assertion EXACT. A finding at the right line is not
 * P2 unless it is actually about the migration divergence between `open()` and
 * `open_with_embedder()` (the migration present in one, absent in the other).
 * A co-located nit about, say, a misleading comment must NOT count as "P2
 * found" — that is a false pass. A correct P2 finding references the peer
 * constructor or describes a migration omission.
 */
function isP2Divergence(f: {
  title?: string; rationale?: string; failure_scenario?: string; suggested_fix?: string;
}) {
  const text =
    `${f.title ?? ""} ${f.rationale ?? ""} ${f.failure_scenario ?? ""} ${f.suggested_fix ?? ""}`.toLowerCase();
  if (text.includes("open_with_embedder")) return true;
  if (text.includes("injected embedder") || text.includes("injected-embedder")) return true;
  return (
    text.includes("migrat") &&
    /(missing|omit|absent|absence|diverge|lacks?|without|unmirrored|not mirrored|only in|peer|sibling|not present|absent from)/.test(
      text,
    )
  );
}

/**
 * Content check for P3 — the dead `migrate_legacy_main_graph_stamp` helper. A
 * finding at onnx.rs:323/681 counts only if it is actually about dead/unused
 * code, not some unrelated issue that happens to share the line.
 */
function isDeadCode(f: {
  title?: string; rationale?: string; failure_scenario?: string; suggested_fix?: string;
}) {
  const text =
    `${f.title ?? ""} ${f.rationale ?? ""} ${f.failure_scenario ?? ""} ${f.suggested_fix ?? ""}`.toLowerCase();
  return /(dead|unused|uncalled|never called|never invoked|not called|leftover|orphan|unreferenced|never reached|no call site|not wired)/.test(
    text,
  );
}

/** P2 = at a genuine defect location AND actually about the migration divergence. */
function p2(findings: any[]) {
  return p2Location(findings) && findings.some((f) => p2Location([f]) && isP2Divergence(f));
}

/** P3 = at the helper location AND actually about dead code. */
function p3(findings: any[]) {
  return p3Location(findings) && findings.some((f) => p3Location([f]) && isDeadCode(f));
}

maybe(
  "re-finds the P2 and the P3 from PR #66 with no fabrications",
  async () => {
    const out = mkdtempSync(join(tmpdir(), "golden-"));
    const r = await runReview({
      repo: REPO,
      base: "origin/main",
      outDir: out,
      skipCargo: true,
      reason: defaultReason({
        model: "zai-coding-plan/glm-5.2",
        promptFile: join(import.meta.dir, "../src/prompts/code-review.md"),
        // 12 steps is too few for glm-5.2 on this diff: it investigates
        // thoroughly, exhausts the budget, and opencode then forces a
        // text-only response (disabling the structured-output mechanism) —
        // observed directly: the model found P2 but could not emit it. The
        // model must cover BOTH the parallel-constructors check (P2) AND the
        // dead-helper check (P3) before emitting, which needs headroom; 25 is
        // the smallest count at which it reliably reaches emit with both
        // covered. Sanctioned by the task brief's debugging step 4 (try 20,
        // 30). The prompt also steers the model to emit promptly rather than
        // spend every step on tool calls.
        steps: 25,
      }),
    });

    const foundP2 = p2(r.findings);
    const foundP3 = p3(r.findings);
    console.log("verdict:", r.verdict, "| findings:", r.findings.length, "| P2:", foundP2, "| P3:", foundP3);
    console.log("usage:", JSON.stringify(r.usage));
    for (const f of r.findings) {
      console.log(`  [${f.severity}/${f.category}] ${f.path}:${f.line} — ${f.title}`);
    }

    // P2: the main_graph migration divergence between open() and open_with_embedder().
    expect(foundP2).toBe(true);
    // P3: the dead migrate_legacy_main_graph_stamp helper in onnx.rs.
    expect(foundP3).toBe(true);
    // no fabrications: EVERY kept finding must resolve against the real tree at
    // HEAD. A finding whose path does not exist on disk is invented and must
    // fail the test — do not relax this to make a flaky turn pass.
    expect(r.findings.every((f) => existsSync(join(REPO, f.path)))).toBe(true);

    rmSync(out, { recursive: true, force: true });
  },
  25 * 60 * 1000,
);
