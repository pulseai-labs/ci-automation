import type { EvidencePack, Finding, ReviewResult } from "../types";
import { SEVERITY_RANK } from "./verdict";

/** Strip anything that could escape the comment structure. Model output is data. */
function esc(s: string): string {
  return String(s)
    .replace(/[<>]/g, c => (c === "<" ? "&lt;" : "&gt;"))
    .replace(/```/g, "ʼʼʼ")
    .trim();
}

function row(f: Finding): string {
  return [
    `#### ${esc(f.title)}`,
    ``,
    `\`${esc(f.path)}:${f.line}\` · **${f.severity}** · ${f.category} · confidence ${f.confidence}`,
    ``,
    esc(f.rationale),
    ``,
    `**Failure scenario:** ${esc(f.failure_scenario)}`,
    ``,
    `**Suggested fix:** ${esc(f.suggested_fix)}`,
    ``,
  ].join("\n");
}

/**
 * Rank findings by `SEVERITY_RANK` (blocker worst, nit least) rather than
 * `localeCompare`-ing the severity strings — see verdict.ts's
 * `SEVERITY_RANK` comment and task-8-brief.md Amendment A3. A plain
 * alphabetical sort of "blocker"/"major"/"minor"/"nit" happens to land on
 * the right order today only because those four words sort that way; this
 * keeps the render order tied to the single canonical rank list instead of
 * that coincidence.
 */
function bySeverity(a: Finding, b: Finding): number {
  return SEVERITY_RANK.indexOf(a.severity) - SEVERITY_RANK.indexOf(b.severity);
}

/**
 * Render a `ReviewResult` to the markdown PR comment. This is the only
 * place model-supplied strings become markdown structure — every field
 * that can hold model output goes through `esc()` first, so injected
 * content (in a diff, or in a model that has been talked into cooperating
 * with it) cannot control the comment's structure. See task-8-brief.md.
 */
export function renderReport(r: ReviewResult, pack: EvidencePack): string {
  const gating = r.findings.filter(f => !f.adjacent);
  const adjacent = r.findings.filter(f => f.adjacent);

  const out: string[] = [];
  out.push(`## VERDICT: ${r.verdict}`, ``, esc(r.reason), ``);

  if (gating.length) {
    out.push(`### Findings`, ``);
    for (const f of [...gating].sort(bySeverity)) out.push(row(f));
  } else {
    out.push(`No gating findings.`, ``);
  }

  if (adjacent.length) {
    out.push(`### Adjacent (pre-existing — does not gate this merge)`, ``);
    for (const f of adjacent) out.push(row(f));
  }

  const notes: string[] = [];
  if (r.capped.length) notes.push(`context truncated in: ${r.capped.map(esc).join(", ")}`);
  if (r.degraded.length) notes.push(...r.degraded.map(esc));
  if (r.usage) {
    notes.push(`tokens in ${r.usage.input} / out ${r.usage.output} / reasoning ${r.usage.reasoning} · cache read ${r.usage.cacheRead}`);
  }
  notes.push(`evidence pack ${pack.budget.bytes} B · head ${esc(pack.head).slice(0, 12)}`);
  out.push(``, `<sub>${notes.join(" · ")}</sub>`);
  return out.join("\n");
}
