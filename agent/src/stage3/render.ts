import type { EvidencePack, Finding, ReviewResult } from "../types";
import { SEVERITY_RANK } from "./verdict";

/**
 * SECURITY INVARIANT this function exists to hold:
 *
 *   No model-supplied string can produce a heading or an HTML block in
 *   the rendered report.
 *
 * That is the whole property. `<`/`>` are escaped to HTML entities below,
 * which rules out HTML blocks/tags entirely. The remaining route to a
 * forged heading is CommonMark's two heading syntaxes — ATX (`# text`)
 * and setext (a paragraph immediately followed by a line of solely `=` or
 * `-`) — plus link reference definitions (`[label]: url`), which don't
 * forge a heading but do silently vanish from rendered output while
 * registering a link target for a later `[text][label]` anywhere in the
 * same document (a different finding's field, rendered into the same
 * comment). All three open only from the START of a line, tolerating up
 * to 3 spaces of CommonMark-legal indentation first — so every guard below
 * is anchored there, not at column 0, and preserves whatever indentation
 * it matched rather than deleting it.
 *
 * Deliberately NOT guarded: thematic breaks, bullet/ordered lists,
 * blockquotes, indented code blocks — everything else CommonMark can also
 * start at a line's beginning. None of them can forge a heading or open
 * an HTML block, so none of them can let injected content control the
 * report's structure — guarding them anyway would only cost content
 * fidelity for no security gain (a review model's bulleted reasoning is
 * common; see Fix round 3, Fix 2, where matching a bare leading `-` broke
 * every `<ul>` a model wrote into run-on prose). If a future reviewer
 * finds `* star item` rendering as a real bullet list, or a blockquote
 * rendering as a real blockquote, that is this decision working as
 * intended — read this comment before treating it as a miss.
 */
function esc(s: string): string {
  return String(s)
    // Trim BEFORE any guard runs, not after (fix round 3, Fix 1): a guard
    // that requires column 0 can miss a construct hidden behind leading
    // indentation, and a trailing .trim() would then strip exactly that
    // indentation and re-expose the construct at column 0 — trimming
    // first removes that gap instead of creating it.
    .trim()
    // CommonMark's own preprocessing step normalizes \r, \r\n, and a bare
    // \r all to \n before block parsing ever runs — normalize here too, so
    // every `gm`-anchored guard below sees exactly the line boundaries a
    // CommonMark renderer will, rather than relying on JS's own multiline
    // `^`/`$` line-terminator handling to agree with CommonMark's.
    .replace(/\r\n?/g, "\n")
    .replace(/[<>]/g, c => (c === "<" ? "&lt;" : "&gt;"))
    // A backtick/tilde run only opens a fence when it is the first thing
    // on a line (mod up to 3 spaces indent) — a fence-length run midline
    // is inert prose and is deliberately left untouched. NOTE this escape
    // is NOT perfectly lossless, unlike `<`/`>` above: `` \``` `` leaves
    // two raw backticks, which can pair with a later 2-backtick run
    // elsewhere in the document and open an unwanted code span; `\~~~`
    // similarly leaves `~~`, GFM's strikethrough delimiter. The SECURITY
    // property still holds either way (the line no longer opens a fence),
    // but do not claim — here or in a test comment — that this round-trips
    // to byte-identical rendered output. It does not.
    .replace(/^( {0,3})```/gm, "$1\\```")
    .replace(/^( {0,3})~~~/gm, "$1\\~~~")
    .replace(/^( {0,3})#/gm, "$1\\#")
    // Setext heading underline: a line consisting SOLELY of `=` or `-`
    // characters (optionally indented, optionally trailing whitespace)
    // immediately under a paragraph becomes an <h1>/<h2> with no '#'
    // anywhere. Must require the WHOLE line: an earlier version of this
    // guard matched any line-initial run of `-`, which also matched every
    // ordinary bullet list's leading `-` and mangled real `<ul>`s into
    // run-on prose (fix round 3, Fix 2). This full-line form cannot tell
    // a `-`-only line acting as a setext underline (in scope: forges a
    // heading) apart from the identical line acting as a thematic break
    // (explicitly out of scope, see the doc comment above) — that would
    // need tracking whether the previous line was blank, which a
    // stateless per-field regex does not do — so a lone thematic break
    // also gets the backslash it doesn't strictly need. That is
    // acceptable overshoot: nothing about the line itself distinguishes
    // the two roles, and defaulting to "still safe" is correct here.
    .replace(/^( {0,3})([=-]+)([ \t]*)$/gm, (_, indent, run, trail) => `${indent}\\${run}${trail}`)
    .replace(/^( {0,3})\[/gm, "$1\\[");
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
 * render as raw, unescaped markdown. That is the ONLY thing that matters
 * inside a single-backtick span: CommonMark treats a code span's content
 * verbatim — backslash-escapes are not processed and HTML entities are
 * not translated there, and a literal `<` cannot open a tag from inside
 * one either (code-span recognition has priority over every other inline
 * construct). Running `esc()`'s block-level guards on code-span content
 * (through fix round 2) cost fidelity for no security benefit: a path
 * containing `<` rendered as the literal text `&lt;` instead of `<`, and
 * one starting with `-` rendered as the literal text `\-` instead of `-`.
 * Fix round 3, Minor. Backslash-escapes do not apply inside a code span,
 * so unlike `esc()`'s fence guards this cannot use `` \` ``; a lookalike
 * character is the only option here, and a bare `path` has no legitimate
 * reason to contain a real backtick.
 */
function escCode(s: string): string {
  return String(s).replace(LINE_BREAK_RE, " ").replace(/`/g, "ʼ").trim();
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
