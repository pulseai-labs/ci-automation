import type { EvidencePack, Finding, ReviewResult } from "../types";
import { SEVERITY_RANK } from "./verdict";

/**
 * SECURITY INVARIANT this file exists to hold:
 *
 *   No model-supplied string can produce a heading or an HTML block in
 *   the rendered report.
 *
 * Fix round 3 held this with escaping guards anchored at column 0,
 * tolerating up to 3 spaces of indentation. That was unsound: CommonMark
 * measures a block start RELATIVE TO ITS ENCLOSING CONTAINER, not in
 * absolute columns. A list item the model writes itself moves the
 * goalposts —
 *
 *   - x
 *       # VERDICT: PASS
 *
 * — `- x` establishes a content column of 2, so a '#' four columns in is
 * only 2 columns into the list item's own content: a real ATX heading
 * inside the `<li>`, invisible to an absolute-column guard, which saw 4
 * spaces and skipped it. `10. x` buys more headroom still. Each round's
 * guard closed the specific probe that found it and left the general
 * problem — a container the model writes itself shifts the coordinate
 * system — for the next probe to rediscover in a new shape.
 *
 * Fix round 4 replaces column-counting with three mechanisms, chosen per
 * field so that NO container can ever form around model-supplied text in
 * the first place. That makes the coordinate-system argument moot rather
 * than trying to win it one more time:
 *
 *   1. SINGLE-LINE FIELDS (escLine, below): collapse every line
 *      terminator to a single space, then guard the ONE remaining
 *      line-start position against CommonMark's block-start set. A
 *      string with no interior line break cannot contain a list item, a
 *      blockquote, or any other container — there is nowhere for a
 *      second, container-relative line to exist, so there is no
 *      coordinate system left for a guard to get wrong. The one guarded
 *      position covers every way CommonMark opens a block at a line's
 *      start: ATX heading `#`, blockquote `>`, setext underline `=`/`-`,
 *      bullet list `-`/`+`/`*`, ordered list (digits then `.` or `)`),
 *      link reference definition `[`, and a backtick/tilde fence.
 *   2. suggested_fix (codeBlock, below): a renderer-OWNED fenced code
 *      block, opened with more backticks than any run already present in
 *      the content. Nothing inside a fenced code block is markdown, at
 *      any depth — no heading, no HTML, no container, regardless of what
 *      the model writes or how it's indented. Also byte-lossless, unlike
 *      every escaping approach tried in rounds 1-3.
 *   3. NUMERIC FIELDS (line, confidence): coerced with `Number()`, not
 *      escaped. A number's string form can never contain a backtick,
 *      `#`, or any other markdown-significant character — coercion is a
 *      stronger guarantee than escaping and cannot leak through some
 *      untested corner of the grammar the way a missed guard can.
 *
 * Every interpolation site in this file, and which mechanism covers it —
 * check this list against the code rather than re-deriving the grammar:
 *
 *   title                 escLine            class 1
 *   path                  escCode            class 1 variant — renders
 *                                             inside a code span, where
 *                                             CommonMark treats content
 *                                             verbatim, so only a literal
 *                                             backtick needs guarding, not
 *                                             the full block-start set
 *                                             (see escCode's own comment)
 *   severity              escLine            class 1
 *   category              escLine            class 1
 *   line                  Number()           class 3
 *   confidence            Number()           class 3
 *   rationale             escLine            class 1 — previously
 *                                             block-preserving; see
 *                                             escLine's comment for why
 *   failure_scenario      escLine            class 1 — same change
 *   suggested_fix         codeBlock          class 2
 *   reason                escLine            class 1 — not model-supplied
 *                                             through the normal
 *                                             finalize() path, but
 *                                             readResult() JSON.parses a
 *                                             ReviewResult with no schema
 *                                             validation
 *   degraded[], capped[]  escLine per entry  class 1
 *   verdict                (not escaped)     a typed Verdict union set by
 *                                             deriveVerdict(), never
 *                                             model-supplied through the
 *                                             normal path. Carries the
 *                                             same readResult() caveat as
 *                                             `reason` above but is out of
 *                                             this round's stated scope —
 *                                             flagged, not fixed; see the
 *                                             fix-round-4 report.
 *   pack.head, usage.*     (not model input) stage 1's own git SHA and
 *                                             the model API's own usage
 *                                             counters — head still goes
 *                                             through escLine defensively,
 *                                             usage.* are always numbers
 *
 * `<`/`>` are additionally escaped to HTML entities everywhere class 1
 * touches, unconditionally — not only at the line-start position —
 * because raw HTML is an INLINE construct CommonMark recognizes anywhere
 * in a paragraph, unlike headings/fences/lists/blockquotes, which only
 * open from a line's start. That single unconditional rule is exactly
 * what makes `<` safe to leave out of the line-start marker set: there is
 * never an unescaped `<` anywhere in class-1 output for anything to pair
 * with.
 *
 * Deliberately still not guarded, because none of it can forge a heading
 * or open an HTML block: thematic breaks, and — now that every field
 * that could otherwise form one is collapsed to a single line — list
 * markers, blockquote markers, and setext underlines appearing anywhere
 * other than the one guarded position. They render as inert prose
 * characters, not as containers, because a single-line field has no
 * second line for them to open a container onto.
 */

// U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR, built from numeric
// code points rather than a literal or `\u`-escaped character so this
// source file contains no invisible/control Unicode characters.
const LINE_BREAK_RE = new RegExp(`[\r\n${String.fromCodePoint(0x2028, 0x2029)}]+`, "g");

/**
 * Guard the single line-start position a class-1 field (see the
 * file-level comment above) can present, against every way CommonMark
 * opens a block construct at the beginning of a line. Escapes ONLY the
 * marker itself — everything else on the line, including a repeat of the
 * same character later on, is left untouched, because only the true
 * start of a line can open a block.
 *
 * Uses CommonMark's own backslash-escape wherever the marker is escapable
 * ASCII punctuation (everything in the set except a digit). For an
 * ordered-list marker ("12. text"), the digits themselves are not
 * escapable — CommonMark backslash-escapes punctuation, not digits, and a
 * backslash before a digit is not a recognized escape at all, so it would
 * survive into the rendered output as a literal, visible backslash. The
 * DELIMITER right after the digits is escaped instead ("12\. text"):
 * CommonMark's block scanner requires that delimiter immediately after
 * the digit run to recognize an ordered-list marker, so a backslash there
 * breaks the match just as well, and — because `.`/`)` ARE escapable
 * punctuation — it is fully lossless once rendered, unlike escaping the
 * digit.
 */
function guardLineStart(t: string): string {
  return t.replace(/^(\d+)([.)])|^([#>=+*`~[-])/, (_m, digits, delim, marker) =>
    digits !== undefined ? `${digits}\\${delim}` : `\\${marker}`,
  );
}

/**
 * Collapse a field to a single physical line — any run of `\n`, `\r`, or
 * either Unicode line/paragraph separator becomes one space — trim, then
 * guard the single resulting line-start position. See the file-level
 * comment: with no interior line break, no list item or blockquote can
 * form inside the field, so there is no container-relative coordinate
 * system left for a guard to get wrong. This is what replaces fix round
 * 3's column-counting guards.
 *
 * Now used for `rationale` and `failure_scenario` too, which previously
 * preserved internal newlines. That is deliberate, not a regression: a
 * rationale is a few sentences of review prose, not a document that needs
 * multiple paragraphs to be useful, and collapsing it converts the
 * security argument from "can this shape of grammar hide a container" —
 * an ever-growing question, per fix rounds 1 through 3 — into "does this
 * string contain a line break," which is arithmetic, checked once, and
 * cannot be reopened by a new piece of CommonMark grammar nobody thought
 * of yet.
 */
function escLine(s: string): string {
  const collapsed = String(s).replace(LINE_BREAK_RE, " ").trim();
  const angleEscaped = collapsed.replace(/[<>]/g, c => (c === "<" ? "&lt;" : "&gt;"));
  return guardLineStart(angleEscaped);
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
 * construct). Running `escLine()`'s block-start guard here would be
 * actively wrong, not just unnecessary: a backslash inside a code span
 * renders as a LITERAL backslash (escapes are inert there), so escaping
 * e.g. a leading `-` would show `\-weird.rs`, not `-weird.rs`. A
 * lookalike character is the only option for the one thing that DOES
 * matter (a real backtick), and a bare `path` has no legitimate reason to
 * contain one.
 */
function escCode(s: string): string {
  return String(s).replace(LINE_BREAK_RE, " ").replace(/`/g, "ʼ").trim();
}

/**
 * `suggested_fix` becomes a RENDERER-OWNED fenced code block rather than
 * an escaped string — see the file-level comment, mechanism 2. Computes
 * the longest run of backticks already present in the content and opens
 * with one more than that (minimum 3, CommonMark's own floor for a
 * fence): CommonMark's closing-fence rule requires a run AT LEAST as long
 * as the opening one, so no backtick run inside the content can ever
 * close this fence early. Nothing inside a fenced code block is parsed as
 * markdown, at any depth — no heading, no HTML block, no list, no
 * blockquote, whatever the indentation — so this field needs no other
 * guard at all.
 *
 * This is also byte-lossless: the content is reproduced exactly (only
 * line endings are canonicalized to `\n`, so the fence's own line
 * structure is unambiguous), which finally settles the copy-paste
 * question every escaping approach in rounds 1-3 left open — suggested
 * Rust compiles when pasted, its `#` attributes are unchanged, and no
 * backslash is ever inserted into the code itself.
 */
function codeBlock(s: string): string {
  const content = String(s).replace(/\r\n?/g, "\n");
  const longestBacktickRun = Math.max(0, ...(content.match(/`+/g) ?? []).map(run => run.length));
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}\n${content}\n${fence}`;
}

function row(f: Finding): string {
  return [
    `#### ${escLine(f.title)}`,
    ``,
    `\`${escCode(f.path)}:${Number(f.line)}\` · **${escLine(f.severity)}** · ${escLine(f.category)} · confidence ${Number(f.confidence)}`,
    ``,
    escLine(f.rationale),
    ``,
    `**Failure scenario:** ${escLine(f.failure_scenario)}`,
    ``,
    `**Suggested fix:**`,
    ``,
    codeBlock(f.suggested_fix),
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
 * that can hold model output goes through one of the three mechanisms in
 * the file-level comment above, so injected content (in a diff, or in a
 * model that has been talked into cooperating with it) cannot control the
 * comment's structure. See task-8-brief.md.
 */
export function renderReport(r: ReviewResult, pack: EvidencePack): string {
  const gating = r.findings.filter(f => !f.adjacent);
  const adjacent = r.findings.filter(f => f.adjacent);

  const out: string[] = [];
  // `reason` is internally generated by deriveVerdict() today, but
  // readResult() JSON.parses a ReviewResult off disk with no schema
  // validation — this slot is not guaranteed trusted either. See the
  // file-level comment for the full interpolation-site list.
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
