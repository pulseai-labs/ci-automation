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
}

/**
 * A container's (impl/trait/mod) full signature list, stored ONCE and
 * referenced by every `SymbolInfo` inside it via `(path, container)` — not
 * copied onto each symbol. This replaces the old `SymbolInfo.siblings`,
 * which duplicated the list once per symbol and made the section
 * O(symbols × container size).
 *
 * Deliberate semantic change from the old `siblings`: that field excluded
 * the symbol itself (`c.items.filter(s => s !== item)`). `signatures`
 * includes every item in the container, the changed one included — that is
 * the only way to store the list once. It is also better context: a reader
 * sees the whole container and can identify the changed item by name.
 */
export interface ContainerInfo {
  path: string;
  container: string;
  /** SIGNATURES ONLY of every item in this container, in source order */
  signatures: string[];
}

export interface EvidencePack {
  head: string;
  diff: string;
  changed: ChangedFile[];
  symbols: SymbolInfo[];
  containers: ContainerInfo[];
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
