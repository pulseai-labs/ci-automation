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
  const r: ReviewResult = { verdict: "PASS", reason: "no findings",
    findings: [], degraded: ["clippy skipped"], capped: ["diff"] };
  const md = renderReport(r, pack);
  // A4: pin the exact footer line rather than the loose substrings the
  // fixture itself already supplies verbatim ("truncated", "clippy
  // skipped") — those would pass even if the footer ignored `pack` and
  // `r.capped`/`r.degraded` entirely and just echoed a hardcoded string.
  expect(md).toContain(
    "<sub>context truncated in: diff · clippy skipped · evidence pack 10 B · head abc</sub>",
  );
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
  expect(result.degraded).toEqual([
    "existing note",
    "1 finding(s) dropped: location did not resolve at head",
  ]);
  // The plan's finalize() returned pack.degraded by reference; assert the
  // caller's evidence pack was not mutated by the push above.
  expect(finPack.degraded).toEqual(["existing note"]);
});
