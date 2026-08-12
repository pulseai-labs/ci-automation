import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDiff, getChangedFiles, TRUNCATION_MARKER, cap } from "../src/stage1/diff";

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "repo-"));
  const sh = (c: string) => Bun.spawnSync(["bash", "-lc", c], { cwd: repo });
  sh("git init -q . && git config user.email t@t && git config user.name t");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/a.rs"), "fn one() {}\n");
  sh("git add -A && git commit -qm base && git branch base");
  writeFileSync(join(repo, "src/a.rs"), "fn one() {}\nfn two() {}\n");
  writeFileSync(join(repo, "src/b.rs"), "fn three() {}\n");
  sh("git add -A && git commit -qm change");
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

test("getChangedFiles lists only .rs files with counts", () => {
  const files = getChangedFiles(repo, "base", "*.rs");
  expect(files.map(f => f.path).sort()).toEqual(["src/a.rs", "src/b.rs"]);
  expect(files.find(f => f.path === "src/b.rs")!.added).toBe(1);
});

test("getDiff returns unified diff with context", () => {
  const { diff, capped } = getDiff(repo, "base", "*.rs", 1_000_000);
  expect(diff).toContain("fn two()");
  expect(capped).toBe(false);
});

test("getDiff caps and marks truncation, reporting the pre-truncation size", () => {
  const { diff, capped, rawBytes } = getDiff(repo, "base", "*.rs", 40);
  expect(capped).toBe(true);
  expect(diff.length).toBeLessThanOrEqual(40 + TRUNCATION_MARKER.length + 40);
  expect(diff).toContain("truncated");
  expect(rawBytes).toBeGreaterThan(40);
});

test("cap() never splits a multi-byte UTF-8 character at the cut boundary", () => {
  // "é" is U+00E9, encoded as 2 bytes (0xC3 0xA9) in UTF-8.
  // Repeat it so a limit lands exactly mid-character, at an odd byte offset.
  const text = "é".repeat(50); // 100 bytes total
  const { text: kept, capped, rawBytes } = cap(text, 41); // 41 is mid-character
  expect(capped).toBe(true);
  expect(rawBytes).toBe(100);
  // The kept portion (before the marker) must contain no U+FFFD replacement
  // character, and must itself be valid whole characters re-encoding to
  // <= the limit in bytes.
  const keptText = kept.slice(0, kept.indexOf(TRUNCATION_MARKER.split("{kept}")[0]!));
  expect(keptText).not.toContain("�");
  expect(Buffer.byteLength(keptText, "utf8")).toBeLessThanOrEqual(41);
});
