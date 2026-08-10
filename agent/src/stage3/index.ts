import type { EvidencePack, Finding, ReviewResult, Severity } from "../types";
import { validate, type DropCode } from "./validate";
import { deriveVerdict } from "./verdict";
export { renderReport } from "./render";

/**
 * Static, human-readable cause text for each `DropCode` — the only text
 * `finalize()` ever puts in the footer for a drop. Deliberately does NOT
 * reuse validate()'s `why` strings: four of the six interpolate `f.path`
 * (one also `f.line`), which is model-supplied — grouping by `why` (as the
 * fix-round-1 review's Amendment A2/Fix 3 did) never actually groups the
 * dominant case, since each invented path produces its own distinct `why`.
 * Five invented paths would still yield five footer clauses, sized and
 * counted entirely by the model. Grouping by `code` instead (see
 * `finalize()` below) bounds the footer at exactly `Object.keys(DROP_CAUSE
 * ).length` clauses — six — no matter what the model returns, and none of
 * this text is model-controlled.
 *
 * "already flagged by a deterministic check" is deliberately worded to
 * sort alphabetically before "duplicate finding" — see
 * agent/test/render.test.ts's grouping-order test, which needs a cause
 * that sorts one way but is inserted the other, to tell insertion-order
 * grouping apart from an accidental alphabetical sort.
 */
const DROP_CAUSE: Record<DropCode, string> = {
  "invalid-severity": "severity was not a recognized value",
  "invalid-category": "category was not a recognized value",
  "path-escapes-repo": "path escaped the repository",
  "path-missing": "path did not exist at head",
  "not-a-regular-file": "path was not a regular file",
  "line-out-of-range": "line number was out of range",
  "duplicate-of-deterministic": "already flagged by a deterministic check",
  "duplicate": "duplicate finding",
};

/**
 * The stage 3 seam: raw findings in, a complete `ReviewResult` out.
 * Validates findings against the real tree, derives the verdict, and
 * surfaces validation drops through the report's `degraded` footer — see
 * task-8-brief.md Amendment A2. Drop-rate is the pipeline's only signal of
 * model hallucination (a model that invents file paths would otherwise
 * produce a clean-looking report with no trace of the discarded findings).
 *
 * `gateOn` (N2): forwarded to `deriveVerdict` unchanged (omitted, it falls
 * back to `deriveVerdict`'s own `DEFAULT_GATE` default, exactly as before
 * this parameter existed). A caller that supplies a non-default `gateOn`
 * here MUST pass that identical value to `render.ts`'s `renderReport()`
 * too — this function's return value (`ReviewResult`) does not carry
 * `gateOn`, so nothing propagates it automatically. See render.ts's
 * `renderReport()` doc comment for why.
 */
export function finalize(raw: Finding[], pack: EvidencePack, repo: string, gateOn?: Severity[]): ReviewResult {
  const all = [...raw, ...pack.clippy, ...(pack.semver ?? [])];
  const { kept, dropped } = validate(all, pack, repo);
  const { verdict, reason } = deriveVerdict(kept, pack, gateOn);
  // Copy, not reference — `pack.degraded` belongs to the caller's evidence
  // pack; pushing into it directly would mutate that shared object.
  const degraded = [...pack.degraded];
  if (dropped.length) {
    // Group by validate()'s stable `code`, not the free-text `why` — see
    // DROP_CAUSE above. Map insertion order keeps this deterministic
    // without imposing an arbitrary sort.
    const byCode = new Map<DropCode, number>();
    for (const { code } of dropped) byCode.set(code, (byCode.get(code) ?? 0) + 1);
    for (const [code, count] of byCode) degraded.push(`${count} finding(s) dropped: ${DROP_CAUSE[code]}`);
  }
  // Copy `capped` too — same aliasing hazard as `degraded` above.
  return { verdict, reason, findings: kept, degraded, capped: [...pack.budget.capped] };
}
