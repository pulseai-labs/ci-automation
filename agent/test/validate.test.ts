import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate } from "../src/stage3/validate";
import type { Finding, EvidencePack } from "../src/types";

function f(over: Partial<Finding> = {}): Finding {
  return {
    severity: "major", category: "correctness",
    path: "src/a.rs", line: 2, title: "t", rationale: "r",
    failure_scenario: "s", suggested_fix: "x",
    source: "agent", confidence: 0.9, ...over,
  };
}

const repo = mkdtempSync(join(tmpdir(), "val-"));
mkdirSync(join(repo, "src"));
writeFileSync(join(repo, "src/a.rs"), "one\ntwo\nthree\n");

const pack = {
  head: "0".repeat(40),
  diff: "--- a/src/a.rs\n+++ b/src/a.rs\n@@ -2,1 +2,1 @@\n-two\n+TWO\n",
  changed: [{ path: "src/a.rs", added: 1, removed: 1 }],
  symbols: [], clippy: [], budget: { bytes: 0, capped: [] }, degraded: [],
} as EvidencePack;

test("drops a finding citing a nonexistent file", () => {
  const r = validate([f({ path: "src/ghost.rs" })], pack, repo);
  expect(r.kept).toHaveLength(0);
  expect(r.dropped).toEqual([
    { finding: f({ path: "src/ghost.rs" }), why: "path does not exist at head: src/ghost.rs" },
  ]);
});

test("drops a finding citing a line past end of file", () => {
  const r = validate([f({ line: 99999 })], pack, repo);
  expect(r.kept).toHaveLength(0);
  expect(r.dropped).toEqual([
    { finding: f({ line: 99999 }), why: "line 99999 outside src/a.rs (4 lines)" },
  ]);
});

test("keeps an in-diff finding and does not mark it adjacent", () => {
  const r = validate([f({ line: 2 })], pack, repo);
  expect(r.kept).toHaveLength(1);
  expect(r.kept[0].adjacent).toBeFalsy();
});

test("keeps an out-of-diff finding but marks it adjacent", () => {
  const r = validate([f({ line: 3 })], pack, repo);
  expect(r.kept).toHaveLength(1);
  expect(r.kept[0].adjacent).toBe(true);
});

test("dedupes an agent finding against an identical clippy finding", () => {
  const withClippy = { ...pack, clippy: [f({ source: "clippy" })] } as EvidencePack;
  const r = validate([f({ source: "agent" })], withClippy, repo);
  expect(r.kept.filter(k => k.source === "agent")).toHaveLength(0);
});

test("a clippy finding survives validate — it is not a duplicate of itself", () => {
  const clippy = f({ source: "clippy", line: 2, title: "clippy lint" });
  const withClippy = { ...pack, clippy: [clippy] } as EvidencePack;
  // exactly what stage 3's finalize() will pass: agent findings AND the
  // deterministic ones, in one list
  const r = validate([clippy], withClippy, repo);
  expect(r.dropped).toEqual([]);
  expect(r.kept).toEqual([{ ...clippy, adjacent: false }]);
});
