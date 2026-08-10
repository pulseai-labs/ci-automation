import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderReport } from "../src/stage3/render";
import { finalize } from "../src/stage3/index";
import type { Finding, ReviewResult, EvidencePack } from "../src/types";

const pack = { head: "abc", diff: "", changed: [], symbols: [], clippy: [],
  budget: { bytes: 10, capped: ["diff"] }, degraded: ["clippy skipped"] } as unknown as EvidencePack;

test("escapes markdown so a finding cannot break out of the report", () => {
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "security", path: "src/a.rs", line: 1,
      title: "</details><script>alert(1)</script>",
      rationale: "```\nbreak out\n```",
      failure_scenario: "s", suggested_fix: "x", source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  // Negative: the raw injectable strings must not survive verbatim.
  expect(md).not.toContain("</details>");
  expect(md).not.toContain("<script>");
  // A1 positive half: the escaped text must actually be PRESENT — a row()
  // that silently dropped `title`/`rationale`, or rendered "", would satisfy
  // the two negative checks above without escaping anything.
  expect(md).toContain("&lt;/details&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  // Fix round 2, Fix 3: the triple-backtick fence is neutralized with a
  // backslash before the line-initial run (`` \``` ``), not a lookalike
  // Unicode character. Correction (fix round 3, Fix 3): this is NOT a
  // perfectly lossless round-trip the way `<`/`>` -> entities is — it
  // leaves two raw backticks that can pair with a later 2-backtick run
  // elsewhere in the document and open an unwanted code span. The
  // SECURITY property holds regardless (this line no longer opens a
  // fence); it just isn't byte-identical once rendered. See esc()'s doc
  // comment in render.ts.
  expect(md).toContain("\\```\nbreak out\n\\```");
});

test("surfaces truncation and degradation in the footer", () => {
  // Fix round 1, Fix 2: `footerPack`'s degraded/capped values are
  // deliberately DIFFERENT from `r`'s. The original test reused the
  // module-level `pack` fixture, which happened to carry the SAME two
  // values as `r` — so a renderer reading `pack.degraded` /
  // `pack.budget.capped` instead of `r.degraded` / `r.capped` produced an
  // identical footer and the mutation was unobservable. It matters because
  // after A2, the drop-count line lives only in `r.degraded` —
  // `pack.degraded` never receives it — so a renderer reading the wrong
  // source would silently delete that signal from the report.
  const footerPack: EvidencePack = {
    head: "abc", diff: "", changed: [], symbols: [], clippy: [],
    budget: { bytes: 10, capped: ["pack-only-capped"] },
    degraded: ["pack-only-degraded"],
  };
  const r: ReviewResult = { verdict: "PASS", reason: "no findings",
    findings: [], degraded: ["clippy skipped"], capped: ["diff"] };
  const md = renderReport(r, footerPack);
  // A4-style: pin the exact footer line rather than loose substrings.
  expect(md).toContain(
    "<sub>context truncated in: diff · clippy skipped · evidence pack 10 B · head abc</sub>",
  );
  // The pack's own degraded/capped values must never leak into the footer.
  expect(md).not.toContain("pack-only-capped");
  expect(md).not.toContain("pack-only-degraded");
});

test("adjacent findings are rendered in a separate, non-gating section", () => {
  const r: ReviewResult = { verdict: "PASS", reason: "no gating findings",
    findings: [{
      severity: "major", category: "correctness", path: "src/a.rs", line: 9,
      title: "pre-existing issue", rationale: "r", failure_scenario: "s",
      suggested_fix: "x", source: "agent", confidence: 0.8, adjacent: true,
    }], degraded: [], capped: [] };
  const md = renderReport(r, pack);
  expect(md).toContain("### Adjacent (pre-existing — does not gate this merge)");
  expect(md).toContain("does not gate");
  // The lone finding is adjacent, so the gating section must say so — not
  // silently list the adjacent finding under "Findings" as if it gated.
  expect(md).toContain("No gating findings.");
});

test("gating findings render in severity rank order, not input order", () => {
  // A3: input order is deliberately NOT rank order (nit, blocker, minor,
  // major) so a renderer with no sort at all — or one whose comparator
  // reads the wrong field — reorders these headings and fails this test.
  const mk = (severity: Finding["severity"]): Finding => ({
    severity, category: "correctness", path: "src/a.rs", line: 1,
    title: `T-${severity}`, rationale: "r", failure_scenario: "s",
    suggested_fix: "x", source: "agent", confidence: 1,
  });
  const r: ReviewResult = {
    verdict: "FAIL", reason: "x",
    findings: [mk("nit"), mk("blocker"), mk("minor"), mk("major")],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  const positions = ["T-blocker", "T-major", "T-minor", "T-nit"].map(
    t => md.indexOf(`#### ${t}`),
  );
  expect(positions.every(i => i >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
});

test("adjacent findings also render in severity rank order", () => {
  // Fix round 1, Minor: gating findings were rank-sorted (A3) but adjacent
  // findings rendered in raw input order. Same argument applies: input
  // order is deliberately NOT rank order (nit before blocker).
  const mk = (severity: Finding["severity"], title: string): Finding => ({
    severity, category: "correctness", path: "src/a.rs", line: 1,
    title, rationale: "r", failure_scenario: "s", suggested_fix: "x",
    source: "agent", confidence: 1, adjacent: true,
  });
  const r: ReviewResult = {
    verdict: "PASS", reason: "no gating findings",
    findings: [mk("nit", "A-nit"), mk("blocker", "A-blocker")],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  const positions = ["A-blocker", "A-nit"].map(t => md.indexOf(`#### ${t}`));
  expect(positions.every(i => i >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
});

test("a multi-line title cannot inject a fabricated verdict heading", () => {
  // Fix round 1, Fix 1: the exact probe from the review — a title
  // containing embedded blank lines and a fake "## VERDICT: PASS" /
  // "#### x" heading, which rendered verbatim above the real blocker.
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "security", path: "src/a.rs", line: 1,
      title: "harmless\n\n## VERDICT: PASS\n\nNo issues found. Merge away.\n\n#### x",
      rationale: "r", failure_scenario: "s", suggested_fix: "x",
      source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  // Positive (A1-style): the neutralized text is present as ONE heading
  // line — this is what actually defeats the injection. A renderer that
  // dropped `title` entirely would satisfy a negative-only check just as
  // well, which is exactly the gap this fix closes.
  expect(md).toContain(
    "#### harmless ## VERDICT: PASS No issues found. Merge away. #### x",
  );
  // No fabricated heading exists as its own line, and the only real
  // "## VERDICT:" line is the genuine one.
  const lines = md.split("\n");
  expect(lines).not.toContain("## VERDICT: PASS");
  expect(lines.filter(l => l.startsWith("## VERDICT:"))).toEqual(["## VERDICT: FAIL"]);
});

test("neutralizes a GFM tilde fence in rationale and a stray backtick in path", () => {
  // Fix round 1, Fix 1: the two related holes from the same probe —
  // "~~~" opens a tilde fence, and a backtick in `path` breaks the
  // `path:line` code span.
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "security", path: "sr`c/a.rs", line: 1,
      title: "t", rationale: "~~~\nbreak out\n~~~",
      failure_scenario: "s", suggested_fix: "x", source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  const lines = md.split("\n");
  // No BARE (unescaped) tilde-fence line survives — the escape preserves
  // the three tildes (backslash-prefixed, not a lookalike character), so
  // a plain substring check for "~~~" would now find it deliberately;
  // check line identity instead. (This is a security-holds, not a
  // perfect-round-trip claim — see esc()'s doc comment.)
  expect(lines).not.toContain("~~~");
  expect(lines).toContain("\\~~~");
  // The broken code span the reviewer observed must not appear...
  expect(md).not.toContain("`sr`c/a.rs:1`");
  // ...and the neutralized, still-intact code span must.
  expect(md).toContain("`srʼc/a.rs:1`");
});

test("a leading '#' on an embedded rationale line cannot become a heading", () => {
  // Fix round 1, Fix 1: rationale/failure_scenario/suggested_fix legitimately
  // span multiple lines, so a line starting with '#' anywhere inside them —
  // not just at field start — must be guarded.
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "security", path: "src/a.rs", line: 1,
      title: "t", rationale: "para one\n\n#### fake heading",
      failure_scenario: "s", suggested_fix: "x", source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  const lines = md.split("\n");
  expect(lines).not.toContain("#### fake heading");
  // Fix round 2, Fix 3: lossless backslash-escape (only the first '#' of
  // the run), not the fullwidth homoglyph — see the header comment on
  // esc() for why a homoglyph corrupts a Rust attribute that a reviewer
  // copy-pastes out of the rendered report.
  expect(lines).toContain("\\#### fake heading");
});

test("the evidence-pack head is truncated before escaping, not after", () => {
  // Fix round 1, Minor: 11 'a's then '<' lands the special char exactly on
  // the 12-char slice boundary. Escaping first (esc(pack.head).slice(0,12))
  // cuts the 4-character "&lt;" entity in half; slicing first never can,
  // since the escape only ever runs on a single already-truncated '<'.
  const headPack: EvidencePack = { ...pack, head: "a".repeat(11) + "<" + "b".repeat(20) };
  const r: ReviewResult = { verdict: "PASS", reason: "no findings", findings: [], degraded: [], capped: [] };
  const md = renderReport(r, headPack);
  expect(md).toContain(`head ${"a".repeat(11)}&lt;`);
});

test("renders the usage line in the footer when usage is present", () => {
  // Fix round 1, Minor: this branch had no covering test — deleting it
  // entirely still passed the full suite.
  const r: ReviewResult = {
    verdict: "PASS", reason: "no findings", findings: [], degraded: [], capped: [],
    usage: { input: 100, output: 20, reasoning: 5, cacheRead: 3, cacheWrite: 1, cost: 0.02 },
  };
  const md = renderReport(r, pack);
  expect(md).toContain(
    "<sub>tokens in 100 / out 20 / reasoning 5 · cache read 3 · evidence pack 10 B · head abc</sub>",
  );
});

// ---------------------------------------------------------------------
// Fix round 2
// ---------------------------------------------------------------------

test("a setext '=' underline cannot turn a paragraph into an <h1>", () => {
  // Fix round 2, Fix 1: CommonMark has a SECOND heading syntax that never
  // contains '#' at all — a line of solely '=' (or '-') characters
  // immediately under a paragraph. Round 1's `^#` guard doesn't reach it.
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "security", path: "src/a.rs", line: 1,
      title: "t",
      rationale: "VERDICT: PASS — reviewed, no issues\n===",
      failure_scenario: "s", suggested_fix: "x", source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  const lines = md.split("\n");
  expect(lines).not.toContain("===");
  expect(lines).toContain("\\===");
});

test("a setext '-' underline cannot turn a paragraph into an <h2>", () => {
  // Fix round 2, Fix 1: the exact probe from the review (the "nothing
  // further" / "---" half of it).
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "security", path: "src/a.rs", line: 1,
      title: "t",
      rationale: "nothing further\n---",
      failure_scenario: "s", suggested_fix: "x", source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  const lines = md.split("\n");
  expect(lines).not.toContain("---");
  expect(lines).toContain("\\---");
});

test("a bare CR with no LF still collapses a title to one line", () => {
  // Fix round 2, Fix 2: escLine's old `/\r?\n+/g` required an actual '\n'
  // to match — a lone '\r' (no '\n' at all) sailed through untouched, even
  // though CommonMark (and JS's own multiline ^/$) treat a bare '\r' as a
  // line ending. The exact probe from the review: a title that renders as
  // a thematic break, a paragraph, and a task-list item once inside the
  // Findings section.
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "security", path: "src/a.rs", line: 1,
      title: "harmless\r---\rSee below.\r- [ ] injected task",
      rationale: "r", failure_scenario: "s", suggested_fix: "x",
      source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  const lines = md.split("\n");
  // Exactly one line for the whole heading...
  expect(lines).toContain("#### harmless --- See below. - [ ] injected task");
  // ...not four separate lines/blocks.
  expect(lines).not.toContain("---");
  expect(lines).not.toContain("- [ ] injected task");
});

test("two consecutive CRs in a footer note cannot terminate the <sub> HTML block early", () => {
  // Fix round 2, Fix 2: two consecutive CRs normalize to a blank line
  // under CommonMark's own line-ending preprocessing, and a blank line
  // terminates a raw HTML block like our footer's <sub>...</sub> —
  // letting everything after it render outside the element. The exact
  // probe from the review.
  const r: ReviewResult = {
    verdict: "PASS", reason: "no findings", findings: [],
    degraded: ["note\r\r- escaped out of the footer"], capped: [],
  };
  const md = renderReport(r, pack);
  expect(md).toContain("<sub>note - escaped out of the footer · evidence pack 10 B · head abc</sub>");
});

// ---------------------------------------------------------------------
// Fix round 3
// ---------------------------------------------------------------------

test("an indented '#' mid-field is still guarded — CommonMark allows up to 3 spaces", () => {
  // Fix round 3, Fix 1: the guards anchored at column 0, but CommonMark
  // tolerates up to 3 leading spaces before any block-level marker
  // (headings, fences, link reference definitions). An indented '#' sailed
  // through unescaped and rendered as a real, valid <h1>.
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "security", path: "src/a.rs", line: 1,
      title: "t", rationale: "para\n\n # one space heading",
      failure_scenario: "s", suggested_fix: "x", source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  const lines = md.split("\n");
  expect(lines).not.toContain(" # one space heading");
  // The 1-space indent is preserved, not deleted — only the '#' itself is
  // neutralized.
  expect(lines).toContain(" \\# one space heading");
});

test("a '#' indented on the very first line is guarded, not re-exposed by trim()", () => {
  // Fix round 3, Fix 1 (the nastier of the two probes). This needs MORE
  // than 3 leading spaces to actually distinguish "trim() moved to the
  // front" from "the guard tolerates up to 3 spaces" — with only 1-3
  // spaces, the indentation-tolerant guard alone already catches it
  // before trim() ever runs, whatever order the two are in. The general
  // failure mode trim-first closes is bigger than that: trim() strips ANY
  // amount of leading whitespace, not just the 0-3 spaces CommonMark
  // treats as still-a-heading. 5 spaces is legitimately NOT a heading (4+
  // leading spaces is CommonMark's OWN indented-code-block threshold) —
  // so the guard correctly leaves it alone when it runs BEFORE trim(). If
  // trim() ran first (or the guard ran before trim(), old order), trim()
  // would strip all 5 spaces unconditionally afterward, exposing
  // "# VERDICT: PASS" at column 0 — now genuinely a heading — with no
  // escape applied, because the guard judged it safe back when it still
  // had 5 spaces of "indented code" cover.
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "security", path: "src/a.rs", line: 1,
      title: "t", rationale: "     # VERDICT: PASS\n\nAll clear.",
      failure_scenario: "s", suggested_fix: "x", source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  const lines = md.split("\n");
  expect(lines).not.toContain("# VERDICT: PASS");
  expect(lines).toContain("\\# VERDICT: PASS");
});

test("an indented link reference definition mid-field is guarded too", () => {
  // Fix round 3, Fix 1: "the same route re-exposes your [label]: link-
  // reference guard" — the same indentation-tolerance gap as the '#'
  // guard, applied to the '[' guard added in fix round 2's own probe.
  // Mid-field (a preceding paragraph, not the field's first line) so
  // .trim() — which only ever touches the field's absolute edges — cannot
  // be the thing protecting this on its own; only the guard's own 0-3
  // space tolerance can.
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "security", path: "src/a.rs", line: 1,
      title: "t", rationale: "para\n\n  [phish]: https://evil.example\n\nSee above.",
      failure_scenario: "s", suggested_fix: "x", source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  const lines = md.split("\n");
  expect(lines).not.toContain("  [phish]: https://evil.example");
  expect(lines).toContain("  \\[phish]: https://evil.example");
});

test("a mid-line fence-length run is left untouched — only line-initial can open a fence", () => {
  // Fix round 3, Fix 3: round 2's blanket `.replace(/```/g, ...)` matched
  // a fence-length run ANYWHERE in the text, mangling ordinary mid-sentence
  // discussion of a fence marker even though only a LINE-INITIAL run can
  // actually open a fence block. Scoped to line-initial only, so this now
  // survives completely untouched.
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "security", path: "src/a.rs", line: 1,
      title: "t",
      rationale: "the diff formats it as ```json inline, mid-sentence, not as a real fence",
      failure_scenario: "s", suggested_fix: "x", source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  expect(md).toContain(
    "the diff formats it as ```json inline, mid-sentence, not as a real fence",
  );
});

test("escCode does not run esc()'s block-level guards — a path with '<' or a leading '-' is untouched", () => {
  // Fix round 3, Minor: escCode used to delegate to escLine (and so to
  // the full esc()), but backslash-escapes and HTML entities are BOTH
  // literal inside a single-backtick code span — CommonMark never
  // processes either there. Running esc()'s guards on code-span content
  // only cost fidelity: a path containing '<' rendered as the literal
  // text "&lt;" instead of '<', and one starting with '-' rendered as the
  // literal text "\-" instead of '-'.
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "security", path: "src/-weird<file>.rs", line: 1,
      title: "t", rationale: "r", failure_scenario: "s", suggested_fix: "x",
      source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  expect(md).toContain("`src/-weird<file>.rs:1`");
});

test("does not mangle ordinary, non-adversarial content", () => {
  // Confirms the escaping doesn't cost a legitimate review anything. Fix
  // round 3, Fix 2's blind spot: the round-2 version of this fixture had
  // NO line-initial '-' at all, so it could not catch the old setext
  // guard mangling an ordinary bullet list — added one here (and, per the
  // fidelity-pass instruction, a numbered list, a blockquote, inline
  // emphasis, and a path with a hyphen too).
  const normalRationale =
    "This function panics on empty input.\n\n" +
    "The check at line 12 assumes `v.len() != 0` without verifying it first.\n\n" +
    "Two problems:\n\n" +
    "- the lock is released early\n" +
    "- the retry loop has no bound\n\n" +
    "Suggested priority:\n\n" +
    "1. fix the lock ordering first\n" +
    "2. add a retry bound second\n\n" +
    "> this exact issue was flagged in the previous review too\n\n" +
    "**This is urgent** because *concurrent* callers hit it in practice.";
  // A real fenced Rust block containing an attribute — this is the case
  // the fidelity pass specifically asks for.
  const suggestedFix =
    "```rust\n#[must_use]\n#[derive(Debug, Clone)]\npub fn checked_len(v: &[u8]) -> usize {\n    v.len()\n}\n```";
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "correctness", path: "src/multi-word-file.rs", line: 12,
      title: "possible panic on empty slice #42",
      rationale: normalRationale,
      failure_scenario: "An empty slice passed here panics instead of returning an error.",
      suggested_fix: suggestedFix,
      source: "agent", confidence: 0.95,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  const lines = md.split("\n");

  // Ordinary paragraph text and an inline code span survive verbatim.
  expect(md).toContain("This function panics on empty input.");
  expect(md).toContain("The check at line 12 assumes `v.len() != 0` without verifying it first.");

  // Bullet list renders as a REAL, unescaped list — fix round 3, Fix 2.
  // Before the fix, the setext guard's `/^(=+|-+)/` also matched a bare
  // leading '-', so this rendered as "\- the lock is released early" and
  // CommonMark joined the two "bullets" into one run-on line instead of a
  // <ul>.
  expect(md).toContain("- the lock is released early");
  expect(md).toContain("- the retry loop has no bound");
  expect(lines).not.toContain("\\- the lock is released early");
  expect(lines).not.toContain("\\- the retry loop has no bound");

  // Numbered list and inline emphasis were never guarded — neither can
  // forge a heading or an HTML block — and survive untouched.
  expect(md).toContain("1. fix the lock ordering first");
  expect(md).toContain("2. add a retry bound second");
  expect(md).toContain("**This is urgent** because *concurrent* callers hit it in practice.");
  // Blockquote is the one fidelity-pass item that does NOT survive as a
  // real `<blockquote>` — its '>' marker is caught by the PRE-EXISTING,
  // position-independent `<`/`>` -> entity escape (unrelated to this
  // round's line-anchored guards, and reaffirmed "fine as-is" in fix
  // round 2 since it is lossless once rendered). That rule can't special-
  // case a line-initial '>' without also touching every other '>' in the
  // same field, so it renders as plain paragraph text starting with the
  // literal characters "&gt;" rather than a real blockquote. Documented,
  // not silently papered over — see the fix-round-3 report's fidelity
  // pass for the full explanation.
  expect(md).toContain("&gt; this exact issue was flagged in the previous review too");

  // A path with a hyphen renders untouched inside its code span.
  expect(md).toContain("`src/multi-word-file.rs:12`");

  // A '#' mid-sentence in title is untouched — only a LINE-INITIAL '#' is
  // guarded, and after escLine's newline-collapse the title is one line
  // that starts with "possible", not "#".
  expect(md).toContain("#### possible panic on empty slice #42");

  // The fenced Rust block's opening/closing fence lines ARE guarded —
  // security requires it; we cannot tell a legitimate quoted fence from a
  // malicious one, so both get neutralized (see esc()'s doc comment). The
  // attribute lines between them use the lossless single-character
  // backslash-escape, so a human reading the RENDERED report still sees
  // "#[must_use]" correctly — only the fence's own formatting is lost,
  // not the code's content.
  expect(md).toContain("\\```rust");
  expect(lines).toContain("\\```");
  expect(md).toContain("\\#[must_use]");
  expect(md).toContain("\\#[derive(Debug, Clone)]");
  // The rest of the suggested Rust code, including the non-line-initial
  // '[' in "&[u8]", is untouched — except the '>' in "->", which gets the
  // SAME lossless entity-escape as always (`&gt;` renders back to '>'; the
  // review confirmed this one is not lossy, unlike the fence homoglyphs
  // fix round 2 replaced).
  expect(md).toContain("pub fn checked_len(v: &[u8]) -&gt; usize {");
  expect(md).toContain("    v.len()");
});

test("a multi-line reason cannot inject structure into the one-line VERDICT summary", () => {
  // Fix round 2, Minor: `reason` used `esc`, not `escLine`, so a multi-line
  // reason rendered as multiple blocks in what is supposed to be a
  // one-line summary. `reason` is internally generated by deriveVerdict()
  // today, but readResult() JSON.parses a ReviewResult off disk with no
  // schema validation, so this slot is not guaranteed trusted either.
  const r: ReviewResult = {
    verdict: "PASS", reason: "ok\n\n## VERDICT: FAIL\n\nGating finding found.",
    findings: [], degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  const lines = md.split("\n");
  expect(lines.filter(l => l.startsWith("## VERDICT:"))).toEqual(["## VERDICT: PASS"]);
  expect(md).toContain("ok ## VERDICT: FAIL Gating finding found.");
});

test("a non-conforming category value is escaped too", () => {
  // Fix round 2, Minor: `f.severity`/`f.category`/`f.line`/`f.confidence`
  // were interpolated without escaping. Nothing in stage 3 verifies enum
  // membership or field types at runtime — it rests entirely on stage 2's
  // schema — so a malformed `category` (e.g. from an unvalidated JSON
  // payload) is not a purely theoretical input. `as any` bypasses the
  // compile-time union here to simulate that.
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "correctness\n\n## VERDICT: PASS" as Finding["category"],
      path: "src/a.rs", line: 1, title: "t", rationale: "r",
      failure_scenario: "s", suggested_fix: "x", source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  const lines = md.split("\n");
  expect(lines.filter(l => l.startsWith("## VERDICT:"))).toEqual(["## VERDICT: FAIL"]);
  expect(md).toContain("correctness ## VERDICT: PASS");
});

test("own probe: an HTML comment cannot open real HTML structure", () => {
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "security", path: "src/a.rs", line: 1,
      title: "t", rationale: "<!-- comment -->\nhidden?",
      failure_scenario: "s", suggested_fix: "x", source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  expect(md).not.toContain("<!--");
  expect(md).toContain("&lt;!-- comment --&gt;");
});

test("own probe: a model-supplied '</sub>'/'<sub>' cannot touch the report's own footer element", () => {
  const r: ReviewResult = {
    verdict: "PASS", reason: "no findings", findings: [],
    degraded: ["</sub><script>alert(1)</script><sub>"], capped: [],
  };
  const md = renderReport(r, pack);
  expect(md).not.toContain("</sub><script>");
  expect(md).toContain("&lt;/sub&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;sub&gt;");
  // Exactly one real <sub> and one real </sub> exist anywhere in the
  // report — the ones render.ts itself emits around the footer.
  expect(md.split("<sub>").length - 1).toBe(1);
  expect(md.split("</sub>").length - 1).toBe(1);
});

test("own probe: a line-initial '[label]:' cannot register a link reference definition", () => {
  // Found while looking for a third route beyond the review's own probes
  // (per the "harden against the class" instruction). A link reference
  // definition — `[label]: url` — is a BLOCK-level construct: it vanishes
  // from rendered output while registering `label` as a link target for
  // any later `[text][label]` in the same document, in a finding the
  // model wrote or a different finding entirely. Guarded the same way as
  // '#'/'='/'-': a leading backslash before the line-initial '['.
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "security", path: "src/a.rs", line: 1,
      title: "t",
      rationale: '[phish]: https://evil.example "click me"\n\nSee [instructions][phish].',
      failure_scenario: "s", suggested_fix: "x", source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  const lines = md.split("\n");
  expect(lines).not.toContain('[phish]: https://evil.example "click me"');
  expect(lines).toContain('\\[phish]: https://evil.example "click me"');
});

test("own probe: U+2028 LINE SEPARATOR in a title cannot smuggle an unescaped '#'", () => {
  // Found while probing beyond the review's explicit list: JS's own
  // multiline `^`/`$` treat U+2028/U+2029 as line terminators (unlike
  // CommonMark, which doesn't), so a title built around one is a plausible
  // "fourth route" alongside \n/\r. escLine's LINE_BREAK_RE (render.ts)
  // now collapses these explicitly rather than relying on esc()'s `gm`
  // guards to catch them as an incidental side effect. Built via
  // fromCodePoint, not a literal/escaped character, so this test file
  // stays free of invisible Unicode too.
  const LS = String.fromCodePoint(0x2028);
  const title = `harmless${LS}## VERDICT: PASS${LS}injected`;
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "security", path: "src/a.rs", line: 1,
      title, rationale: "r", failure_scenario: "s", suggested_fix: "x",
      source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  expect(md).toContain("#### harmless ## VERDICT: PASS injected");
  expect(md).not.toContain(LS);
});

test("finalize() surfaces dropped findings via the footer's degraded list, without mutating pack.degraded", () => {
  const repo = mkdtempSync(join(tmpdir(), "finalize-"));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/a.rs"), "one\n");

  const finPack: EvidencePack = {
    head: "abc", diff: "", changed: [{ path: "src/a.rs", added: 1, removed: 0 }],
    symbols: [], clippy: [], budget: { bytes: 10, capped: [] },
    degraded: ["existing note"],
  };

  const resolvable: Finding = {
    severity: "major", category: "correctness", path: "src/a.rs", line: 1,
    title: "t", rationale: "r", failure_scenario: "s", suggested_fix: "x",
    source: "agent", confidence: 0.9,
  };
  const unresolvable: Finding = {
    severity: "major", category: "correctness", path: "src/missing.rs", line: 1,
    title: "t2", rationale: "r", failure_scenario: "s", suggested_fix: "x",
    source: "agent", confidence: 0.9,
  };

  const result = finalize([resolvable, unresolvable], finPack, repo);

  expect(result.findings).toEqual([{ ...resolvable, adjacent: true }]);
  // Fix round 2, Fix 4: grouped by validate()'s stable `code`, with a
  // static human-readable cause — NOT `why` (round 1's Fix 3), which
  // interpolates the model-supplied path and would let the model control
  // both the clause count and each clause's length.
  expect(result.degraded).toEqual([
    "existing note",
    "1 finding(s) dropped: path did not exist at head",
  ]);
  // The plan's finalize() returned pack.degraded by reference; assert the
  // caller's evidence pack was not mutated by the push above.
  expect(finPack.degraded).toEqual(["existing note"]);

  // Fix round 1, Minor: verdict/reason/capped wiring was previously
  // unobserved by this test — a finalize() that hardcoded
  // `verdict: "PASS"` would have passed it before.
  expect(result.verdict).toBe("PASS");
  expect(result.reason).toBe("1 non-gating finding(s)");
  expect(result.capped).toEqual([]);
  // `capped` must be a copy too (same aliasing hazard as `degraded`) —
  // mutating the returned array must not leak into the evidence pack.
  result.capped.push("mutated-after-return");
  expect(finPack.budget.capped).toEqual([]);
});

test("finalize() groups dropped findings by distinct code — insertion order, not alphabetical", () => {
  // Fix round 1, Fix 3 (grouping) + Fix round 2, Fix 4 (group by `code`,
  // not `why`) + Fix round 2, Minor (disambiguate insertion order from
  // alphabetical order). Three distinct drop causes:
  //  1. two duplicates of `base` -> code "duplicate" (inserted 1st)
  //  2. one unresolvable path -> code "path-missing" (inserted 2nd)
  //  3. one finding duplicating a CLIPPY finding -> code
  //     "duplicate-of-deterministic" (inserted 3rd, LAST)
  // DROP_CAUSE's text for #3, "already flagged by a deterministic check",
  // sorts alphabetically BEFORE #1's "duplicate finding" — so a mutation
  // that alphabetically sorted the grouped lines instead of using Map
  // insertion order would move #3 to the FRONT of the array and this
  // assertion would fail. Round 1's version of this test used only #1/#2,
  // whose causes happen to already sort the same way they're inserted, so
  // an alphabetical-sort mutation would have survived undetected.
  const repo = mkdtempSync(join(tmpdir(), "finalize-group-"));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/a.rs"), "one\ntwo\n");

  const base: Finding = {
    severity: "major", category: "correctness", path: "src/a.rs", line: 1,
    title: "t", rationale: "r", failure_scenario: "s", suggested_fix: "x",
    source: "agent", confidence: 0.9,
  };
  const clippyFinding: Finding = { ...base, source: "clippy", category: "security", line: 2 };

  const finPack: EvidencePack = {
    head: "abc", diff: "", changed: [{ path: "src/a.rs", added: 1, removed: 0 }],
    symbols: [], clippy: [clippyFinding], budget: { bytes: 10, capped: [] }, degraded: [],
  };

  const duplicate1: Finding = { ...base, title: "dup1" };
  const duplicate2: Finding = { ...base, title: "dup2" };
  const unresolvable: Finding = { ...base, path: "src/missing.rs", title: "gone" };
  const dupOfClippy: Finding = { ...base, source: "agent", category: "security", line: 2, title: "dup-of-clippy" };

  const result = finalize(
    [base, duplicate1, duplicate2, unresolvable, dupOfClippy],
    finPack, repo,
  );

  expect(result.degraded).toEqual([
    "2 finding(s) dropped: duplicate finding",
    "1 finding(s) dropped: path did not exist at head",
    "1 finding(s) dropped: already flagged by a deterministic check",
  ]);
});

test("finalize() bounds the footer to one clause per drop cause, regardless of how many distinct paths the model invents", () => {
  // Fix round 2, Fix 4: four of validate()'s six `why` strings interpolate
  // f.path (one also f.line), so round 1's group-by-`why` never actually
  // grouped the dominant case — 5 invented paths produced 5 footer
  // clauses, sized and counted by the model. Grouping by `code` instead
  // bounds the footer regardless of how many distinct paths appear.
  const repo = mkdtempSync(join(tmpdir(), "finalize-bound-"));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/a.rs"), "one\n");

  const finPack: EvidencePack = {
    head: "abc", diff: "", changed: [{ path: "src/a.rs", added: 1, removed: 0 }],
    symbols: [], clippy: [], budget: { bytes: 10, capped: [] }, degraded: [],
  };

  const mk = (path: string): Finding => ({
    severity: "major", category: "correctness", path, line: 1,
    title: "t", rationale: "r", failure_scenario: "s", suggested_fix: "x",
    source: "agent", confidence: 0.9,
  });

  const result = finalize(
    [mk("src/invented1.rs"), mk("src/invented2.rs"), mk("src/invented3.rs")],
    finPack, repo,
  );

  expect(result.degraded).toEqual([
    "3 finding(s) dropped: path did not exist at head",
  ]);
});

test("finalize()'s dropped-finding line reaches the rendered footer", () => {
  // Fix round 1, Fix 2 (second half): nothing previously piped finalize()'s
  // output into renderReport() — the finalize test only ever called
  // finalize(). A renderer reading pack.degraded instead of r.degraded (the
  // exact mutation Fix 2 describes) would delete this line silently, and no
  // test would have caught it.
  const repo = mkdtempSync(join(tmpdir(), "finalize-render-"));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/a.rs"), "one\n");

  const finPack: EvidencePack = {
    head: "abc", diff: "", changed: [{ path: "src/a.rs", added: 1, removed: 0 }],
    symbols: [], clippy: [], budget: { bytes: 10, capped: [] }, degraded: [],
  };
  const resolvable: Finding = {
    severity: "major", category: "correctness", path: "src/a.rs", line: 1,
    title: "t", rationale: "r", failure_scenario: "s", suggested_fix: "x",
    source: "agent", confidence: 0.9,
  };
  const unresolvable: Finding = {
    severity: "major", category: "correctness", path: "src/missing.rs", line: 1,
    title: "t2", rationale: "r", failure_scenario: "s", suggested_fix: "x",
    source: "agent", confidence: 0.9,
  };

  const result = finalize([resolvable, unresolvable], finPack, repo);
  const md = renderReport(result, finPack);

  expect(md).toContain(
    "<sub>1 finding(s) dropped: path did not exist at head · evidence pack 10 B · head abc</sub>",
  );
});
