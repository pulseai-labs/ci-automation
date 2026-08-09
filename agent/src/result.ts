import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewResult } from "./types";

const FILE = "result.json";

export function initResult(dir: string): void {
  writeResult(dir, {
    verdict: "ERROR",
    reason: "orchestrator did not complete",
    findings: [], degraded: [], capped: [],
  });
}

export function writeResult(dir: string, r: ReviewResult): void {
  writeFileSync(join(dir, FILE), JSON.stringify(r, null, 2));
}

export function readResult(dir: string): ReviewResult {
  const p = join(dir, FILE);
  if (!existsSync(p)) {
    return { verdict: "ERROR", reason: `result.json missing at ${p}`,
             findings: [], degraded: [], capped: [] };
  }
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ReviewResult;
  } catch {
    return { verdict: "ERROR", reason: "result.json malformed",
             findings: [], degraded: [], capped: [] };
  }
}
