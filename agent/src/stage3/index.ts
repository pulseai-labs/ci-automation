import type { EvidencePack, Finding, ReviewResult } from "../types";
import { validate } from "./validate";
import { deriveVerdict } from "./verdict";
export { renderReport } from "./render";

/**
 * The stage 3 seam: raw findings in, a complete `ReviewResult` out.
 * Validates findings against the real tree, derives the verdict, and
 * surfaces validation drops through the report's `degraded` footer — see
 * task-8-brief.md Amendment A2, and Fix 3 of the fix-round-1 review for the
 * per-`why` grouping. Drop-rate is the pipeline's only signal of model
 * hallucination (a model that invents file paths would otherwise produce a
 * clean-looking report with no trace of the discarded findings).
 */
export function finalize(raw: Finding[], pack: EvidencePack, repo: string): ReviewResult {
  const all = [...raw, ...pack.clippy, ...(pack.semver ?? [])];
  const { kept, dropped } = validate(all, pack, repo);
  const { verdict, reason } = deriveVerdict(kept, pack);
  // Copy, not reference — `pack.degraded` belongs to the caller's evidence
  // pack; pushing into it directly would mutate that shared object.
  const degraded = [...pack.degraded];
  if (dropped.length) {
    // Group by the exact `why` validate() gave each drop — six distinct
    // causes exist (bad path, wrong line, two kinds of duplicate, ...), and
    // collapsing them all under one fixed label would misreport, e.g., a
    // duplicate clippy finding as "location did not resolve at head". Map
    // insertion order keeps this deterministic without imposing an
    // arbitrary sort on free-text reasons.
    const byWhy = new Map<string, number>();
    for (const { why } of dropped) byWhy.set(why, (byWhy.get(why) ?? 0) + 1);
    for (const [why, count] of byWhy) degraded.push(`${count} finding(s) dropped: ${why}`);
  }
  // Copy `capped` too — same aliasing hazard as `degraded` above.
  return { verdict, reason, findings: kept, degraded, capped: [...pack.budget.capped] };
}
