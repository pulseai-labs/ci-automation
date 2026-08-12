import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectLanguage, getLanguage } from "../src/stage1/languages";

test("detectLanguage returns null when no manifest is present", () => {
  const dir = mkdtempSync(join(tmpdir(), "nolang-"));
  expect(detectLanguage(dir)).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test("getLanguage returns null for an unregistered name", () => {
  expect(getLanguage("cobol")).toBeNull();
});
