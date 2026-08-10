import type { EvidencePack, Finding, ReviewResult, Severity } from "../types";
import { DEFAULT_GATE, isGating, SEVERITY_RANK } from "./verdict";

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
 * than trying to win it one more time. Fix round 5 (reviewer-confirmed
 * closed: 290 payload/slot combinations, 18 fence-break attempts, all
 * three container probes — zero leaks) added a fourth variant of
 * mechanism 1 to recover paragraph structure without reopening any of
 * that:
 *
 *   1. SINGLE-LINE FIELDS (escLine, below): collapse every line
 *      terminator to a single space, then guard the ONE remaining
 *      line-start position against CommonMark's block-start set. A
 *      string with no interior line break cannot contain a list item, a
 *      blockquote, or any other container — there is nowhere for a
 *      second, container-relative line to exist, so there is no
 *      coordinate system left for a guard to get wrong. The one guarded
 *      position covers every way CommonMark opens a block at a line's
 *      start: ATX heading `#`, setext underline `=`/`-`, bullet list
 *      `-`/`+`/`*`, ordered list (digits then `.` or `)`), link reference
 *      definition `[`, and a backtick/tilde fence. (Blockquote `>` is
 *      NOT in this set — see the `<`/`>` paragraph below for why.)
 *   1b. MULTI-LINE BLOCK FIELDS (escParagraphs, below): the SAME
 *      predicate as escLine — "does this string contain a line break" —
 *      applied per piece instead of once. Splits on every line break,
 *      runs escLine on each resulting piece independently, drops empty
 *      pieces, and rejoins with a blank line. Every emitted line is still
 *      a renderer-controlled, single-line, guarded paragraph; the blank
 *      line between pieces is what keeps a container from spanning two
 *      of them and defeats a setext underline (which needs no blank line
 *      between the paragraph and the underline). This is not a new
 *      mechanism, only mechanism 1 applied more than once per field — see
 *      escParagraphs's own comment.
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
 *   rationale             escParagraphs      class 1b — collapsed
 *                                             (class 1) in fix round 4;
 *                                             fix round 5 recovers
 *                                             paragraph structure without
 *                                             changing the predicate
 *   failure_scenario      escParagraphs      class 1b — same change
 *   suggested_fix         codeBlock          class 2
 *   reason                escLine            class 1 — not model-supplied
 *                                             through the normal
 *                                             finalize() path, but
 *                                             readResult() JSON.parses a
 *                                             ReviewResult with no schema
 *                                             validation
 *   verdict                escLine           class 1 — same readResult()
 *                                             caveat as `reason`; fix
 *                                             round 4 left this out of
 *                                             scope, fix round 5 closes it
 *   degraded[], capped[]  escLine per entry  class 1
 *   pack.head              escLine           not model input — stage 1's
 *                                             own git SHA — escaped
 *                                             defensively anyway
 *   pack.budget.bytes      (not escaped)     not model input — stage 1's
 *                                             own byte-budget count,
 *                                             always a number
 *   usage.*                (not escaped)     not model input — the model
 *                                             API's own usage counters,
 *                                             always numbers
 *
 * `<`/`>` are additionally escaped to HTML entities everywhere class 1
 * (and 1b) touches, unconditionally — not only at the line-start position
 * — because raw HTML is an INLINE construct CommonMark recognizes
 * anywhere in a paragraph, unlike headings/fences/lists/blockquotes,
 * which only open from a line's start. That single unconditional rule is
 * exactly what makes both `<` and `>` safe to leave out of the line-start
 * marker set: there is never an unescaped `<` OR `>` anywhere in
 * class-1(b) output for anything to pair with, and `guardLineStart`
 * itself notes why an entry for `>` there specifically would be dead
 * code, not defense in depth.
 *
 * Deliberately still not guarded, because none of it can forge a heading
 * or open an HTML block: thematic breaks, and list/blockquote/setext
 * markers appearing anywhere other than the start of a guarded piece.
 * They render as inert prose characters, not as containers, because
 * every class-1(b) piece is a single physical line with no second line
 * for them to open a container onto.
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
 *
 * Deliberately does NOT include `>` (blockquote): `escLine` below always
 * entity-escapes `<`/`>` before calling this function, so a leading `>`
 * has already become `&gt;` by the time this regex ever sees the string —
 * an entry for it here could never fire. Adding one back would be dead
 * code, not defense in depth.
 */
function guardLineStart(t: string): string {
  return t.replace(/^(\d+)([.)])|^([#=+*`~[-])/, (_m, digits, delim, marker) =>
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
 * 3's column-counting guards, and the SAME predicate — "does this string
 * contain a line break" — is what `escParagraphs()` below applies per
 * piece instead of once, for fields that need to keep their paragraph
 * breaks.
 *
 * Used directly (whole-field collapse) for slots that are genuinely a
 * single line of content by nature: `title`, `path`, `severity`,
 * `category`, `reason`, `verdict`, and each footer entry. `rationale` and
 * `failure_scenario` used this directly too in fix round 4 — see fix
 * round 5, Fix 2 for why they now go through `escParagraphs()` instead.
 */
function escLine(s: string): string {
  const collapsed = String(s).replace(LINE_BREAK_RE, " ").trim();
  const angleEscaped = collapsed.replace(/[<>]/g, c => (c === "<" ? "&lt;" : "&gt;"));
  return guardLineStart(angleEscaped);
}

/**
 * Preserve paragraph structure for a block field (`rationale`,
 * `failure_scenario`) without weakening class 1's security argument. Fix
 * round 4 collapsed these fields the same as every other class-1 field —
 * correctly closing the invariant, but at a real fidelity cost: a
 * realistic multi-paragraph rationale rendered as one run-on line with
 * stray list/quote markers inline.
 *
 * Splits the field on every line break, runs `escLine()` on each piece
 * INDEPENDENTLY, drops any piece that comes out empty (a run of blank
 * lines collapses to nothing rather than an empty paragraph), then
 * rejoins the pieces with a blank line (`\n\n`). Every emitted line is
 * therefore still a renderer-controlled, trimmed, single-line paragraph
 * with its OWN guarded start position — exactly `escLine()`'s guarantee,
 * just applied once per piece instead of once per field:
 *
 *   - No container can span two pieces, because a blank line always
 *     separates them and a list item or blockquote cannot continue across
 *     one.
 *   - No piece carries indentation into the next, because each is
 *     independently trimmed.
 *   - A setext underline needs a paragraph immediately followed — no
 *     blank line — by a line of solely `=`/`-`; splitting on every line
 *     break and rejoining with `\n\n` guarantees a blank line between
 *     every pair of adjacent pieces, so that adjacency can never occur.
 *
 * The predicate stays exactly "does this string contain a line break" —
 * this function does not reason about CommonMark grammar at all, only
 * about where THIS string's line breaks are — so nothing about class 1's
 * closed argument (see the file-level comment) changes; splitting first
 * only changes how many single-line pieces one field's text is cut into
 * before that unchanged predicate runs on each.
 */
function escParagraphs(s: string): string {
  return String(s)
    .split(LINE_BREAK_RE)
    .map(escLine)
    .filter(piece => piece.length > 0)
    .join("\n\n");
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
  // `suggested_fix` is always Rust (this pipeline reviews Rust diffs only —
  // see stage1/diff.ts's `*.rs` scoping) — tag the opening fence with the
  // language so the rendered PR comment syntax-highlights it. The info
  // string is only meaningful on the OPENING fence; CommonMark ignores one
  // on a closing fence, so `fence` alone (no tag) still closes correctly.
  return `${fence}rust\n${content}\n${fence}`;
}

function row(f: Finding): string {
  return [
    `#### ${escLine(f.title)}`,
    ``,
    `\`${escCode(f.path)}:${Number(f.line)}\` · **${escLine(f.severity)}** · ${escLine(f.category)} · confidence ${Number(f.confidence)}`,
    ``,
    escParagraphs(f.rationale),
    ``,
    `**Failure scenario:** ${escParagraphs(f.failure_scenario)}`,
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
 *
 * `gateOn` (N2): deriveVerdict's `gateOn` is deliberate public API — a
 * caller may derive the verdict with a non-default gate tier list — and
 * this file's own `isGating()` call must partition findings against THE
 * SAME `gateOn`, or the report can show a finding under "Other findings
 * (do not gate)" that the verdict just counted as gating (fix-round-review
 * I2, reopened: I2's original fix shared the isGating() PREDICATE between
 * verdict.ts and render.ts but not the `gateOn` ARGUMENT, so an
 * unparameterized `isGating(f)` here silently fell back to DEFAULT_GATE
 * regardless of what the caller passed to deriveVerdict). Defaults to the
 * same `DEFAULT_GATE` deriveVerdict itself defaults to, so every existing
 * caller (which never passed a custom `gateOn` to either function) is
 * unaffected; a caller that DOES use a non-default `gateOn` must pass the
 * identical value here that it passed to `deriveVerdict` (and, if going
 * through `finalize()`, to `finalize()`'s own `gateOn` parameter) to keep
 * the verdict and the report in agreement — `ReviewResult` itself carries
 * no `gateOn` field to auto-propagate this (see
 * .superpowers/sdd/final-review-fixes.md's N2 section for why that
 * stamped-partition alternative was not chosen here).
 */
export function renderReport(r: ReviewResult, pack: EvidencePack, gateOn: Severity[] = DEFAULT_GATE): string {
  // Three-way split using verdict.ts's OWN gating predicate (`isGating`) —
  // not a second, render-local notion of "gating" (fix-round-review I2: the
  // previous split was `!f.adjacent` alone, no severity check, so a
  // non-adjacent minor/nit finding rendered under a heading whose count
  // line above it said "N gating finding(s)" — a human reads that as a
  // blocker. `other` is deliberately the complement of both `blocking` and
  // `adjacent` (not, say, "everything not blocking"), so every finding
  // lands in exactly one of the three sections.
  const blocking = r.findings.filter(f => isGating(f, gateOn));
  const other = r.findings.filter(f => !f.adjacent && !isGating(f, gateOn));
  const adjacent = r.findings.filter(f => f.adjacent);

  const out: string[] = [];
  // `verdict` and `reason` are both internally generated (deriveVerdict())
  // through the normal finalize() path, but readResult() JSON.parses a
  // ReviewResult off disk with no schema validation — neither slot is
  // guaranteed trusted. See the file-level comment for the full
  // interpolation-site list.
  out.push(`## VERDICT: ${escLine(r.verdict)}`, ``, escLine(r.reason), ``);

  if (blocking.length) {
    out.push(`### Blocking`, ``);
    for (const f of [...blocking].sort(bySeverity)) out.push(row(f));
  } else {
    out.push(`No gating findings.`, ``);
  }

  if (other.length) {
    out.push(`### Other findings (do not gate)`, ``);
    for (const f of [...other].sort(bySeverity)) out.push(row(f));
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
