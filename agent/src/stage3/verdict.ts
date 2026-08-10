import type { EvidencePack, Finding, Severity, Verdict } from "../types";

// Every deny-by-default clippy lint reaches this gate as severity "major"
// (agent/src/stage1/lint.ts:71 maps error-level clippy diagnostics to
// "major"). Dropping "major" here would silently turn every one of those
// off without any type error — see task-7-brief.md Amendment A1.
const DEFAULT_GATE: Severity[] = ["blocker", "major"];

// Severity, worst first. Used only to label a FAIL's `reason` with the
// highest severity actually present among the gating findings — `gateOn`
// (not this list) governs what gates at all, and `gateOn` is a
// caller-supplied parameter that is not limited to blocker/major.
const SEVERITY_RANK: Severity[] = ["blocker", "major", "minor", "nit"];

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
  // Adjacent findings (stage3/validate.ts marks findings outside the diff's
  // touched lines `adjacent: true`) never gate, whatever their severity.
  const gating = findings.filter(f => !f.adjacent && gateOn.includes(f.severity));
  if (gating.length > 0) {
    const worst = SEVERITY_RANK.find(s => gating.some(f => f.severity === s))!;
    return { verdict: "FAIL", reason: `${gating.length} gating finding(s), highest severity ${worst}` };
  }
  if (findings.length > 0) {
    return { verdict: "PASS", reason: `${findings.length} non-gating finding(s)` };
  }
  return { verdict: "PASS", reason: "no findings" };
}
