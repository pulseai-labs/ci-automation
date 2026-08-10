import type { EvidencePack, Finding, Severity, Verdict } from "../types";

// Every deny-by-default clippy lint reaches this gate as severity "major"
// (agent/src/stage1/lint.ts:71 maps error-level clippy diagnostics to
// "major"). Dropping "major" here would silently turn every one of those
// off without any type error — see task-7-brief.md Amendment A1.
//
// Exported (N2) so render.ts can default its OWN `gateOn` parameter to the
// exact same value deriveVerdict defaults to, instead of hardcoding an
// unparameterized `isGating(f)` call that silently drifts from whatever
// `gateOn` a caller actually passed to deriveVerdict.
export const DEFAULT_GATE: Severity[] = ["blocker", "major"];

// Severity, worst first. Used to label a FAIL's `reason` with the highest
// severity actually present among the gating findings — `gateOn` (not this
// list) governs what gates at all, and `gateOn` is a caller-supplied
// parameter that is not limited to blocker/major. Exported so stage3/render.ts
// can sort findings by rank instead of relying on the alphabet putting
// "blocker" < "major" < "minor" < "nit" by coincidence.
export const SEVERITY_RANK: Severity[] = ["blocker", "major", "minor", "nit"];

/**
 * The single definition of "does this finding gate the merge" — exported so
 * stage3/render.ts can split its report the same way this function derives
 * the verdict, instead of carrying its own, different, "gating" predicate
 * (fix-round-review I2: render.ts used to bucket on `!f.adjacent` alone,
 * with no severity check at all, which could label a non-adjacent minor or
 * nit finding as "gating" even though it never gated anything here).
 */
export function isGating(f: Finding, gateOn: Severity[] = DEFAULT_GATE): boolean {
  // Adjacent findings (stage3/validate.ts marks findings outside the diff's
  // touched lines `adjacent: true`) never gate, whatever their severity.
  return !f.adjacent && gateOn.includes(f.severity);
}

/**
 * Derive the merge verdict from typed `Finding` fields only — never from a
 * regex or substring match over `title`, `rationale`, `failure_scenario`,
 * or any other prose field. The classifier this replaces scans review
 * PROSE for phrases like "quota" or "Exec failed" and misfires on findings
 * that merely mention those words in a passing review (spec §9); this
 * function must not repeat that mistake.
 */
export function deriveVerdict(
  findings: Finding[],
  pack: EvidencePack,
  gateOn: Severity[] = DEFAULT_GATE,
): { verdict: Verdict; reason: string } {
  if (pack.changed.length === 0) {
    return { verdict: "INCONCLUSIVE", reason: "no changed Rust files in this diff" };
  }
  // C1-D: a byte-capped diff (stage1/diff.ts's `cap()`) makes validate()'s
  // adjacency computation for AGENT findings unreliable — `touched` was
  // built by walking a diff that may have been cut off mid-hunk, so a real
  // finding sitting in the truncated region can come back `adjacent: true`
  // and silently fail to gate (a fail-open). Only go INCONCLUSIVE when the
  // truncation could actually have changed a gating decision: the diff was
  // capped AND at least one agent-authored finding whose severity would
  // otherwise gate (`gateOn`) was marked adjacent. Deliberately NOT every
  // capped diff — a huge PR with no findings at all, or with only
  // non-gating-severity findings, is unaffected by this uncertainty and
  // must still resolve normally, or every large PR would become
  // unmergeable regardless of its actual content.
  if (pack.budget.capped.includes("diff")) {
    const uncertain = findings.filter(f => f.source === "agent" && f.adjacent && gateOn.includes(f.severity));
    if (uncertain.length > 0) {
      return {
        verdict: "INCONCLUSIVE",
        reason: `diff truncated: cannot confirm ${uncertain.length} finding(s) marked adjacent are pre-existing`,
      };
    }
  }
  const gating = findings.filter(f => isGating(f, gateOn));
  if (gating.length > 0) {
    const worst = SEVERITY_RANK.find(s => gating.some(f => f.severity === s))!;
    return { verdict: "FAIL", reason: `${gating.length} gating finding(s), highest severity ${worst}` };
  }
  if (findings.length > 0) {
    return { verdict: "PASS", reason: `${findings.length} non-gating finding(s)` };
  }
  return { verdict: "PASS", reason: "no findings" };
}
