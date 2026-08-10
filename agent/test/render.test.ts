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
  expect(md).toContain("ʼʼʼ\nbreak out\nʼʼʼ");
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
  // "~~~" opens a tilde fence esc() didn't rewrite, and a backtick in
  // `path` breaks the `path:line` code span.
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
  expect(md).not.toContain("~~~");
  expect(md).toContain("〜〜〜\nbreak out\n〜〜〜");
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
  expect(md).toContain("＃### fake heading");
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
  // Fix round 1, Fix 3: the drop line names the REAL why validate() gave,
  // not A2's hardcoded "location did not resolve at head" — which was
  // simply wrong for e.g. a duplicate-finding drop.
  expect(result.degraded).toEqual([
    "existing note",
    "1 finding(s) dropped: path does not exist at head: src/missing.rs",
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

test("finalize() groups dropped findings by distinct why, not one hardcoded label", () => {
  // Fix round 1, Fix 3: two duplicates of the same kept finding (dropped
  // why "duplicate finding") plus one unrelated unresolvable path (dropped
  // for a different why) must produce two distinct, correctly-counted
  // degraded lines — not one line reporting 3 drops under a single wrong
  // cause.
  const repo = mkdtempSync(join(tmpdir(), "finalize-group-"));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/a.rs"), "one\n");

  const finPack: EvidencePack = {
    head: "abc", diff: "", changed: [{ path: "src/a.rs", added: 1, removed: 0 }],
    symbols: [], clippy: [], budget: { bytes: 10, capped: [] }, degraded: [],
  };

  const base: Finding = {
    severity: "major", category: "correctness", path: "src/a.rs", line: 1,
    title: "t", rationale: "r", failure_scenario: "s", suggested_fix: "x",
    source: "agent", confidence: 0.9,
  };
  const duplicate1: Finding = { ...base, title: "dup1" };
  const duplicate2: Finding = { ...base, title: "dup2" };
  const unresolvable: Finding = { ...base, path: "src/missing.rs", title: "gone" };

  const result = finalize([base, duplicate1, duplicate2, unresolvable], finPack, repo);

  expect(result.degraded).toEqual([
    "2 finding(s) dropped: duplicate finding",
    "1 finding(s) dropped: path does not exist at head: src/missing.rs",
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
    "<sub>1 finding(s) dropped: path does not exist at head: src/missing.rs · evidence pack 10 B · head abc</sub>",
  );
});
