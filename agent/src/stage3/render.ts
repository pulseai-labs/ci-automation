import type { EvidencePack, Finding, ReviewResult } from "../types";
import { SEVERITY_RANK } from "./verdict";

/**
 * Neutralize markdown control sequences using CommonMark's own lossless
 * backslash-escape mechanism wherever one exists, so escaped output still
 * reads — and, once rendered, copy-pastes — as the original text. `<`/`>`
 * become HTML entities (`&lt;`/`&gt;`; a renderer turns these back into the
 * literal character, so this is lossless too). Every other guard below
 * inserts a backslash before the first character of a BLOCK-level marker
 * at a line's start — backtick-fence, tilde-fence, ATX heading (`#`),
 * setext heading underline (a line of solely `=` or `-` — CommonMark's
 * *second* heading syntax; a paragraph followed by such a line becomes an
 * `<h1>`/`<h2>` even though it never contains `#`), and link reference
 * definition (`[label]: url`, which silently vanishes from the rendered
 * text while registering a link target any later `[text][label]` in the
 * same document would resolve to). Each of those requires that exact RAW
 * character to begin the line; a leading backslash breaks the match
 * without deleting or visibly altering the text once rendered — CommonMark
 * backslash-escapes every ASCII punctuation character, including all of
 * these. Preserves internal newlines — rationale, failure_scenario, and
 * suggested_fix legitimately span multiple lines (e.g. quoting a
 * multi-line snippet). Model output is data, not markdown.
 */
function esc(s: string): string {
  return String(s)
    // CommonMark's own preprocessing step normalizes \r, \r\n, and a bare
    // \r all to \n before block parsing ever runs — normalize here too, so
    // every `gm`-anchored guard below sees exactly the line boundaries a
    // CommonMark renderer will, rather than relying on JS's own multiline
    // `^`/`$` line-terminator handling to agree with CommonMark's.
    .replace(/\r\n?/g, "\n")
    .replace(/[<>]/g, c => (c === "<" ? "&lt;" : "&gt;"))
    .replace(/```/g, "\\```")
    .replace(/~~~/g, "\\~~~")
    .replace(/^#/gm, "\\#")
    .replace(/^(=+|-+)/gm, m => "\\" + m[0] + m.slice(1))
    .replace(/^\[/gm, "\\[")
    .trim();
}

/**
 * Single-line variant of `esc()` for slots that must never become more
 * than one physical line — title, path, category, reason, and the footer
 * notes. Collapses any run of embedded line breaks — `\n`, `\r`, or any
 * mix (a bare `\r` with no `\n` is still a CommonMark line ending, even
 * though it alone does not satisfy JS's `/\n/`) — to a single space BEFORE
 * the rest of `esc()` runs, so a model cannot use a line break inside e.g.
 * `title` to open a new markdown block: the injection probe that
 * motivated this embedded a fabricated `## VERDICT: PASS` heading in
 * `title` this way, and a later probe did the same with a bare `\r`.
 *
 * Also collapses U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR —
 * built via LINE_BREAK_RE below from numeric code points rather than a
 * literal or escaped character, so this source file contains no
 * invisible/control Unicode characters. CommonMark does not recognize
 * either as a line ending, so on its own this pair was never a
 * structural gap — but ECMAScript's own multiline `^`/`$` DO treat them
 * as line terminators, so `esc()`'s `gm`-anchored guards below would
 * fire after one anyway (verified by probe: an unescaped '#' following a
 * U+2028 still came out backslash-escaped). Collapsing them here too
 * makes the single-line invariant this function promises hold
 * explicitly, rather than as an incidental side effect of `esc()`'s
 * unrelated guards. (Form feed U+000C and NEL U+0085 were also probed —
 * neither ECMAScript's `^`/`$` nor CommonMark's line-ending definition
 * treat them as line breaks, so no code path here or in a real Markdown
 * renderer parses text after one as being at a fresh line; left alone.)
 */
// U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR, built from numeric
// code points rather than a literal or `\u`-escaped character so this
// source file contains no invisible/control Unicode characters.
const LINE_BREAK_RE = new RegExp(`[\r\n${String.fromCodePoint(0x2028, 0x2029)}]+`, "g");

function escLine(s: string): string {
  return esc(String(s).replace(LINE_BREAK_RE, " "));
}

/**
 * Escape a value embedded inside a single-backtick code span
 * (`` `path:line` ``, in `row()` below) — a literal backtick in the value
 * would otherwise close the span early and let the remainder of the line
 * render as raw, unescaped markdown. Backslash-escapes do not apply
 * inside a code span (CommonMark: everything between the delimiters is
 * literal), so unlike `esc()`'s fence guards this cannot use `` \` ``; a
 * lookalike character is the only option here, and a bare `path` has no
 * legitimate reason to contain a real backtick.
 */
function escCode(s: string): string {
  return escLine(s).replace(/`/g, "ʼ");
}

function row(f: Finding): string {
  return [
    `#### ${escLine(f.title)}`,
    ``,
    `\`${escCode(f.path)}:${f.line}\` · **${f.severity}** · ${escLine(f.category)} · confidence ${f.confidence}`,
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
  // `reason` is internally generated by deriveVerdict() today, but
  // readResult() JSON.parses a ReviewResult off disk with no schema
  // validation — this slot is not guaranteed trusted either, and it must
  // stay on one physical line the same as title/path/footer notes.
  out.push(`## VERDICT: ${r.verdict}`, ``, escLine(r.reason), ``);

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
