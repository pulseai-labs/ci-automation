import type { EvidencePack, Finding, ReviewResult } from "../types";
import { SEVERITY_RANK } from "./verdict";

/**
 * Neutralize markdown control sequences without deleting the text: escape
 * `<`/`>`, rewrite both GFM fence delimiters (backtick-fence and
 * tilde-fence), and guard a leading `#` on any line so embedded text
 * cannot open an ATX heading. Preserves internal newlines — rationale,
 * failure_scenario, and suggested_fix legitimately span multiple lines
 * (e.g. quoting a multi-line snippet). Model output is data, not markdown.
 */
function esc(s: string): string {
  return String(s)
    .replace(/[<>]/g, c => (c === "<" ? "&lt;" : "&gt;"))
    .replace(/```/g, "ʼʼʼ")
    .replace(/~~~/g, "〜〜〜")
    .replace(/^#/gm, "＃")
    .trim();
}

/**
 * Single-line variant of `esc()` for slots that must never become more
 * than one physical line — title, path, and the footer notes. Collapses
 * any run of embedded newlines to a single space BEFORE the rest of
 * `esc()` runs, so a model cannot use a blank line inside e.g. `title` to
 * open a new markdown block: the injection probe that motivated this
 * embedded a fabricated `## VERDICT: PASS` heading in `title` this way.
 */
function escLine(s: string): string {
  return esc(String(s).replace(/\r?\n+/g, " "));
}

/**
 * Escape a value embedded inside a single-backtick code span
 * (`` `path:line` ``, in `row()` below) — a literal backtick in the value
 * would otherwise close the span early and let the remainder of the line
 * render as raw, unescaped markdown.
 */
function escCode(s: string): string {
  return escLine(s).replace(/`/g, "ʼ");
}

function row(f: Finding): string {
  return [
    `#### ${escLine(f.title)}`,
    ``,
    `\`${escCode(f.path)}:${f.line}\` · **${f.severity}** · ${f.category} · confidence ${f.confidence}`,
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
    for (const f of [...adjacent].sort(bySeverity)) out.push(row(f));
  }

  const notes: string[] = [];
  if (r.capped.length) notes.push(`context truncated in: ${r.capped.map(escLine).join(", ")}`);
  if (r.degraded.length) notes.push(...r.degraded.map(escLine));
  if (r.usage) {
    notes.push(`tokens in ${r.usage.input} / out ${r.usage.output} / reasoning ${r.usage.reasoning} · cache read ${r.usage.cacheRead}`);
  }
  // Slice first, escape second — escaping first risks cutting a multi-char
  // entity (e.g. "&lt;") in half if the special character lands near the
  // truncation boundary.
  notes.push(`evidence pack ${pack.budget.bytes} B · head ${escLine(pack.head.slice(0, 12))}`);
  out.push(``, `<sub>${notes.join(" · ")}</sub>`);
  return out.join("\n");
}
