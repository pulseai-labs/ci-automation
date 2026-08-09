export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE" | "ERROR";

export type Severity = "blocker" | "major" | "minor" | "nit";
export type Category =
  | "correctness" | "security" | "data-loss" | "api-contract" | "maintainability";

export interface Finding {
  severity: Severity;
  category: Category;
  path: string;
  line: number;
  title: string;
  rationale: string;
  failure_scenario: string;
  suggested_fix: string;
  source: "agent" | "clippy" | "semver";
  confidence: number;
  /** set by stage 3; findings outside the diff do not gate */
  adjacent?: boolean;
}

export interface ChangedFile { path: string; added: number; removed: number }

export interface SymbolInfo {
  path: string;
  name: string;
  kind: string;
  container: string;
  /** SIGNATURES ONLY of sibling items in the same container */
  siblings: string[];
}

export interface EvidencePack {
  head: string;
  diff: string;
  changed: ChangedFile[];
  symbols: SymbolInfo[];
  clippy: Finding[];
  apiDelta?: string;
  semver?: Finding[];
  budget: { bytes: number; capped: string[] };
  degraded: string[];
}

export interface Usage {
  input: number; output: number; reasoning: number;
  cacheRead: number; cacheWrite: number; cost: number;
}

export interface ReviewResult {
  verdict: Verdict;
  reason: string;
  findings: Finding[];
  usage?: Usage;
  degraded: string[];
  capped: string[];
}
