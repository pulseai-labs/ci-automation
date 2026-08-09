import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initResult, writeResult, readResult } from "../src/result";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "res-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("initResult writes a terminal ERROR before any work happens", () => {
  initResult(dir);
  const r = readResult(dir);
  expect(r.verdict).toBe("ERROR");
  expect(r.reason).toBe("orchestrator did not complete");
  expect(r.findings).toEqual([]);
});

test("writeResult overwrites the pre-seeded ERROR", () => {
  initResult(dir);
  writeResult(dir, {
    verdict: "PASS", reason: "no findings",
    findings: [], degraded: [], capped: [],
  });
  expect(readResult(dir).verdict).toBe("PASS");
});

test("readResult on a missing file reports ERROR, never PASS", () => {
  const r = readResult(join(dir, "nope"));
  expect(r.verdict).toBe("ERROR");
  expect(r.reason).toContain("missing");
});

test("readResult on malformed JSON reports ERROR, never PASS", () => {
  writeFileSync(join(dir, "result.json"), "{not json");
  const r = readResult(dir);
  expect(r.verdict).toBe("ERROR");
  expect(r.reason).toContain("malformed");
});
