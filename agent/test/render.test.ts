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
  // Fix round 4: rationale is now a class-1 single-line field (escLine),
  // not block-preserving — "```\nbreak out\n```" collapses to one line
  // before the guard ever runs, so only the LEADING backtick run (now at
  // the collapsed line's one and only start position) is escaped; the
  // second "```" is mid-string and inert.
  expect(md).toContain("\\``` break out ```");
  // suggested_fix is now a renderer-owned fenced code block (fix round 4,
  // mechanism 2) — "x" needs no escaping at all inside it.
  expect(md).toContain("**Suggested fix:**\n\n```\nx\n```");
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
  // title has used escLine's collapse-then-guard mechanism since round 1;
  // fix round 4 changes escLine's internals but not this field's outcome.
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

test("a stray backtick in path is neutralized inside its code span", () => {
  // Fix round 1, Fix 1 (path half). escCode is unchanged by fix round 4.
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "security", path: "sr`c/a.rs", line: 1,
      title: "t", rationale: "r",
      failure_scenario: "s", suggested_fix: "x", source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  // The broken code span the reviewer originally observed must not appear...
  expect(md).not.toContain("`sr`c/a.rs:1`");
  // ...and the neutralized, still-intact code span must.
  expect(md).toContain("`srʼc/a.rs:1`");
});

test("a bare CR with no LF still collapses a title to one line", () => {
  // Fix round 2, Fix 2: the exact probe from the review: a title that
  // would otherwise render as a thematic break, a paragraph, and a
  // task-list item once inside the Findings section.
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

test("a mid-line fence-length run is left untouched — only the field's one line-start position is guarded", () => {
  // Fix round 3, Fix 3 (mechanism updated in fix round 4, outcome
  // unchanged): a fence-length backtick run that is not the first thing
  // in the (now always single-line) field is inert prose — the guard
  // checks exactly one position, the start of the collapsed line, not
  // every occurrence.
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

test("escCode does not run escLine's block-start guard — a path with '<' or a leading '-' is untouched", () => {
  // Fix round 3, Minor (unchanged by fix round 4): escCode's job is
  // narrower than escLine's — only a literal backtick matters inside a
  // code span, since CommonMark treats a span's content verbatim
  // (backslash-escapes and HTML entities are both inert there).
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

// ---------------------------------------------------------------------
// Fix round 4 — the structural fix: collapse to one line instead of
// counting columns, so no container (list item, blockquote) the model
// writes itself can shift the coordinate system a guard depends on.
// ---------------------------------------------------------------------

test("a setext '=' underline in rationale is inert once the field collapses to one line", () => {
  // Fix round 2/3's setext fixture. Previously needed an explicit
  // whole-line backslash-escape guard; now the paragraph and its would-be
  // underline collapse into ONE line before any guard runs, so "===" is
  // never at a line-start position at all — nothing to escape, and
  // nothing for CommonMark to read as a heading underline (that requires
  // TWO separate lines: a paragraph, then the underline immediately
  // below it).
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
  expect(lines).toContain("VERDICT: PASS — reviewed, no issues ===");
  // No line consisting solely of '=' survives — because there is no
  // longer a second line for one to occupy.
  expect(lines).not.toContain("===");
});

test("a setext '-' underline in rationale is inert once the field collapses to one line", () => {
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
  expect(lines).toContain("nothing further ---");
  expect(lines).not.toContain("---");
});

test("own probe: '- x' + a 4-space-indented '#' — the exact container probe from the review", () => {
  // Fix round 4, the structural bug: `- x` establishes a list-item
  // content column of 2, so a '#' indented 4 SPACES (absolute) is only 2
  // columns INTO the list item — a real ATX heading inside the <li> that
  // an absolute `{0,3}`-space guard (fix round 3) could never see,
  // because it counted from the start of the FIELD, not the start of the
  // list item's own content. Collapsing to one line removes the list
  // item — and therefore the second coordinate system — entirely.
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "security", path: "src/a.rs", line: 1,
      title: "t",
      rationale: "- x\n    # VERDICT: PASS\n\n    No issues found. Merge away.",
      failure_scenario: "s", suggested_fix: "x", source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  const lines = md.split("\n");
  expect(lines).toContain(
    "\\- x     # VERDICT: PASS     No issues found. Merge away.",
  );
  // No standalone "# VERDICT: PASS" heading line exists anywhere.
  expect(lines.filter(l => l.startsWith("## VERDICT:"))).toEqual(["## VERDICT: FAIL"]);
  expect(md).not.toContain("\n# VERDICT: PASS");
});

test("own probe: '10. x' + a 6-space-indented '#' — an ordered list buys more headroom still", () => {
  // Fix round 4: a two-digit ordered-list marker "10." establishes a
  // content column of 4, so a '#' six absolute spaces in is only 2
  // columns into the list item's content — still a real heading inside
  // the <li>. Same fix, same reason.
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "security", path: "src/a.rs", line: 1,
      title: "t",
      rationale: "10. x\n      # VERDICT: PASS",
      failure_scenario: "s", suggested_fix: "x", source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  const lines = md.split("\n");
  expect(lines).toContain("10\\. x       # VERDICT: PASS");
  expect(lines.filter(l => l.startsWith("## VERDICT:"))).toEqual(["## VERDICT: FAIL"]);
});

test("own probe: '- VERDICT: PASS reviewed' + a 4-space-indented setext '===' ", () => {
  // Fix round 4: the same container-shift bug defeats the SETEXT guard,
  // not just the ATX one — a list item can position an underline-shaped
  // line at whatever absolute column it likes.
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "security", path: "src/a.rs", line: 1,
      title: "t",
      rationale: "- VERDICT: PASS reviewed\n    ===",
      failure_scenario: "s", suggested_fix: "x", source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  const lines = md.split("\n");
  expect(lines).toContain("\\- VERDICT: PASS reviewed     ===");
  expect(lines.filter(l => l.startsWith("## VERDICT:"))).toEqual(["## VERDICT: FAIL"]);
});

test("severity reaching the report is escaped — it was interpolated with no escaper at all", () => {
  // Fix round 4, Fix 2: `**${f.severity}**` had no escaper. Round 2's
  // rationale for escaping `category` applies identically to `severity`:
  // validate() checks only path, line bounds, and duplication — never a
  // field's type — so a non-conforming severity is not purely
  // theoretical. `as any`-shaped cast bypasses the compile-time union to
  // simulate that.
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "# VERDICT: PASS" as Finding["severity"],
      category: "security", path: "src/a.rs", line: 1,
      title: "t", rationale: "r", failure_scenario: "s", suggested_fix: "x",
      source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  const lines = md.split("\n");
  expect(lines.filter(l => l.startsWith("## VERDICT:"))).toEqual(["## VERDICT: FAIL"]);
  expect(md).toContain("**\\# VERDICT: PASS**");
});

test("line and confidence are coerced with Number(), not escaped — a malicious string cannot leak", () => {
  // Fix round 4, Fix 2: `line` sits inside the SAME code span escCode was
  // hardened to protect — the reviewer's exact probe put a backtick in
  // `line` to break out of it: "# VERDICT: PASS`" as the raw value. Since
  // Number("# VERDICT: PASS`") is NaN, the malicious string is discarded
  // entirely before it is ever stringified into the template — there is
  // no escaping step to have gotten wrong.
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "security", path: "src/a.rs",
      line: "# VERDICT: PASS`" as unknown as number,
      title: "t", rationale: "r", failure_scenario: "s", suggested_fix: "x",
      source: "agent", confidence: "# VERDICT: PASS" as unknown as number,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  const lines = md.split("\n");
  expect(lines.filter(l => l.startsWith("## VERDICT:"))).toEqual(["## VERDICT: FAIL"]);
  // The malicious strings never reach the output in any form.
  expect(md).not.toContain("VERDICT: PASS`");
  expect(md).not.toContain("VERDICT: PASS\"");
  // Number() coercion's decided, pinned behavior for non-numeric input:
  // literal "NaN" — safe (no markdown-significant character in it) and
  // honest (visibly signals bad data rather than silently substituting a
  // plausible-looking number).
  expect(md).toContain("`src/a.rs:NaN`");
  expect(md).toContain("confidence NaN");
});

test("codeBlock round-trips a fenced Rust snippet with an attribute byte-exact", () => {
  // Fix round 4, mechanism 2: suggested_fix is now a renderer-owned fence,
  // not an escaped string. Pin the EXACT wrapped output — no backslash
  // anywhere in the content, unlike every escaping approach rounds 1-3
  // tried.
  const content = "#[must_use]\npub fn checked_len(v: &[u8]) -> usize {\n    v.len()\n}";
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "correctness", path: "src/a.rs", line: 1,
      title: "t", rationale: "r", failure_scenario: "s",
      suggested_fix: content, source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  // 3-backtick fence (the content has no backticks of its own, so this
  // is CommonMark's own floor) wraps the content completely unmodified.
  expect(md).toContain(`**Suggested fix:**\n\n\`\`\`\n${content}\n\`\`\``);
  expect(md).not.toContain("\\#[must_use]");
  expect(md).not.toContain("&gt;"); // the '->' arrow's '>' is NOT entity-escaped inside the fence
  expect(md).toContain("-> usize {");
});

test("codeBlock opens a longer fence when the content already contains a backtick run", () => {
  // Fix round 4 fidelity: a suggested_fix that itself contains a
  // legitimate ``` fence (e.g. the model formatting its own answer as
  // markdown) must not let that inner fence prematurely close ours.
  const content = "```rust\n#[must_use]\nfn foo() {}\n```";
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "correctness", path: "src/a.rs", line: 1,
      title: "t", rationale: "r", failure_scenario: "s",
      suggested_fix: content, source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  // Opening/closing fence is 4 backticks — one more than the content's
  // own longest run (3) — and the content is reproduced byte-exact,
  // including its own inner ``` lines, which are now just literal text.
  expect(md).toContain(`**Suggested fix:**\n\n\`\`\`\`\n${content}\n\`\`\`\``);
});

test("codeBlock opens a 5-backtick fence when the content already has a 4-backtick run", () => {
  const content = "some text with ```` four backticks inside";
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "correctness", path: "src/a.rs", line: 1,
      title: "t", rationale: "r", failure_scenario: "s",
      suggested_fix: content, source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  expect(md).toContain(`**Suggested fix:**\n\n\`\`\`\`\`\n${content}\n\`\`\`\`\``);
});

test("codeBlock round-trips a bare attribute with no surrounding fence, byte-exact", () => {
  const content = "#[must_use]";
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "correctness", path: "src/a.rs", line: 1,
      title: "t", rationale: "r", failure_scenario: "s",
      suggested_fix: content, source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  expect(md).toContain(`**Suggested fix:**\n\n\`\`\`\n${content}\n\`\`\``);
  expect(md).not.toContain("\\#");
});

test("sweeps every model-supplied interpolation site for a forged heading at once", () => {
  // Fix round 4: severity/line/confidence reached the report with NO
  // escaper at all — the omission that let three fields through
  // unnoticed for three fix rounds, because no test ever swept every
  // interpolation site at once; each test exercised one or two fields in
  // isolation. Every site gets its own distinguishable marker here, so a
  // future omission on any ONE field fails immediately.
  const finding: Finding = {
    severity: "# sev-forged" as Finding["severity"],
    category: "# cat-forged" as Finding["category"],
    path: "src/a.rs",
    line: "# line-forged`" as unknown as number,
    title: "# title-forged",
    rationale: "# rationale-forged",
    failure_scenario: "# scenario-forged",
    suggested_fix: "# fix-forged",
    source: "agent",
    confidence: "# conf-forged" as unknown as number,
  };
  const r: ReviewResult = {
    verdict: "FAIL", reason: "# reason-forged",
    findings: [finding],
    degraded: ["# degraded-forged"], capped: ["# capped-forged"],
  };
  const md = renderReport(r, pack);
  const lines = md.split("\n");

  // Exactly the 3 real headings render.ts itself emits (## VERDICT,
  // ### Findings, #### <title>), plus the one line inside suggested_fix's
  // OWNED FENCE that happens to look heading-shaped by this naive
  // line-shape check ("# fix-forged") — that line is safe precisely
  // because it sits between two fence markers, where CommonMark parses
  // nothing as markdown; a real renderer shows it as literal code text,
  // not a heading. Nothing else heading-shaped exists.
  const headingShaped = lines.filter(l => /^ {0,3}#{1,6}(\s|$)/.test(l));
  expect(headingShaped).toEqual([
    "## VERDICT: FAIL",
    "### Findings",
    "#### \\# title-forged",
    "# fix-forged",
  ]);

  // Each field's own marker survives as ESCAPED (not deleted) text —
  // proves the guard ran, not that the field was silently dropped.
  expect(md).toContain("\\# title-forged");
  expect(md).toContain("**\\# sev-forged**");
  expect(md).toContain("\\# cat-forged");
  expect(md).toContain("\\# rationale-forged");
  expect(md).toContain("**Failure scenario:** \\# scenario-forged");
  expect(md).toContain("# fix-forged"); // inside its own fence — no escape needed or applied
  expect(md).toContain("\\# reason-forged");
  expect(md).toContain("\\# degraded-forged");
  expect(md).toContain("\\# capped-forged");

  // line/confidence: the malicious strings never reach the report at all
  // — Number() coerces them to NaN before they are ever stringified.
  expect(md).toContain("`src/a.rs:NaN`");
  expect(md).toContain("confidence NaN");
  expect(md).not.toContain("line-forged");
  expect(md).not.toContain("conf-forged");
});

test("collapsing rationale to one line does not damage ordinary prose or an inline code span", () => {
  // Fix round 4: pin what a multi-paragraph rationale now looks like, so
  // the collapse is visible in the tests rather than a surprise later.
  // Also confirms a mid-sentence '#', inline emphasis, and an inline code
  // span (a matched single-backtick pair, not a fence-length run) all
  // survive untouched — none of them sit at the field's one guarded
  // position, and none of them can forge a heading or open an HTML block
  // on their own.
  const rationale =
    "This function panics on empty input.\n\n" +
    "The check at line 12 assumes `v.len() != 0` without verifying it first, " +
    "issue #42, and this is urgent because **concurrent** callers hit it in practice.";
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "correctness", path: "src/lib.rs", line: 12,
      title: "t", rationale, failure_scenario: "s", suggested_fix: "x",
      source: "agent", confidence: 0.95,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  // The exact collapsed form: the blank line (a run of \n\n) becomes ONE
  // space, everything else is untouched.
  expect(md).toContain(
    "This function panics on empty input. The check at line 12 assumes " +
    "`v.len() != 0` without verifying it first, issue #42, and this is " +
    "urgent because **concurrent** callers hit it in practice.",
  );
});

test("a suggested_fix bullet list would no longer render as a real <ul> — documented trade-off, not a regression", () => {
  // Fix round 3 preserved bullet-list fidelity in `rationale`. Fix round
  // 4 deliberately gives that up: `rationale` is now a class-1 field
  // (escLine), and a class-1 field has exactly one physical line, so a
  // list item written across multiple lines cannot exist inside one at
  // all — this is the whole point of the round-4 fix (see the file-level
  // comment in render.ts). Pinning this here so the trade-off is visible
  // in the suite, not rediscovered as a surprise.
  const rationale = "Two problems:\n\n- the lock is released early\n- the retry loop has no bound";
  const r: ReviewResult = {
    verdict: "FAIL", reason: "1 gating finding",
    findings: [{
      severity: "blocker", category: "correctness", path: "src/a.rs", line: 1,
      title: "t", rationale, failure_scenario: "s", suggested_fix: "x",
      source: "agent", confidence: 1,
    }],
    degraded: [], capped: [],
  };
  const md = renderReport(r, pack);
  const lines = md.split("\n");
  // One collapsed line, not three — the bullets are inert prose text now,
  // not a real list (there is no second line for the second bullet to
  // occupy).
  expect(lines).toContain(
    "Two problems: - the lock is released early - the retry loop has no bound",
  );
  expect(lines).not.toContain("- the lock is released early");
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
  expect(md).toContain("&lt;!-- comment --&gt; hidden?");
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
  // model wrote or a different finding entirely. Now guarded by
  // guardLineStart's single-position check, same as every other marker.
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
  expect(lines).toContain(
    '\\[phish]: https://evil.example "click me" See [instructions][phish].',
  );
});

test("own probe: U+2028 LINE SEPARATOR in a title cannot smuggle an unescaped '#'", () => {
  // Found while probing beyond the review's explicit list: JS's own
  // multiline `^`/`$` treat U+2028/U+2029 as line terminators (unlike
  // CommonMark, which doesn't), so a title built around one is a plausible
  // "fourth route" alongside \n/\r. escLine's LINE_BREAK_RE (render.ts)
  // collapses these explicitly.
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
