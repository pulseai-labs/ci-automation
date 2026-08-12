import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language, type Node } from "web-tree-sitter";
import type { ChangedFile, ContainerInfo, Finding, SymbolInfo } from "../../types";
import { changedLines, rangeTouched, type ChangedLines } from "../hunks";
import { have, spawnGuarded } from "../cargoProbe";
import type { ApiToolsResult, LanguageModule, LinterResult, SymbolResult, ToolOpts } from "./types";
import { SYMBOL_PATTERNS } from "./patterns";

// ===========================================================================
// symbol extraction — moved verbatim from symbols.ts
// ===========================================================================

/**
 * Real Rust parser (web-tree-sitter + tree-sitter-rust), not a hand-rolled
 * brace-matcher. Plan amendment (operator-approved): the original no-tree-sitter
 * constraint was derived from cfg-blindness in code GRAPHS doing semantic
 * resolution across files, where picking the wrong `#[cfg]` branch is
 * dangerous. This module does no resolution — it reads syntax and emits
 * signature text verbatim from source, both `#[cfg]` branches included. The
 * constraint was over-applied here and has been withdrawn for this task.
 */

const CONTAINER_TYPES = new Set(["impl_item", "trait_item", "mod_item"]);
const FUNCTION_TYPES = new Set(["function_item", "function_signature_item"]);

interface Item {
  name: string;
  kind: string;
  signature: string;
  /** exact node rows (0-indexed, inclusive) — no line-based drift */
  startRow: number;
  endRow: number;
}

interface ContainerNode {
  label: string;
  items: Item[];
}

let languagePromise: Promise<Language> | null = null;

/** Lazily init the WASM runtime and load the Rust grammar, once per process.
 *  Resolved via import.meta.resolve so it works regardless of process CWD
 *  (this runs from a GitHub Actions step whose CWD is not the agent dir). */
function loadLanguage(): Promise<Language> {
  if (!languagePromise) {
    languagePromise = (async () => {
      await Parser.init();
      const wasmUrl = import.meta.resolve("tree-sitter-rust/tree-sitter-rust.wasm");
      return Language.load(fileURLToPath(wasmUrl));
    })();
  }
  return languagePromise;
}

/**
 * Source text from `node`'s start to the start of its `body` field (or to
 * the node's own end, if it has no body — e.g. a trait method signature
 * ending in `;`), trimmed and collapsed to one line.
 *
 * A body can never leak into a signature by construction: the slice never
 * extends past `body.startIndex`.
 */
function headerText(src: string, node: Node): string {
  const body = node.childForFieldName("body");
  const end = body ? body.startIndex : node.endIndex;
  return src.slice(node.startIndex, end).trim().replace(/\s+/g, " ");
}

/**
 * Walk the tree once, grouping function-like items under the nearest
 * enclosing impl/trait/mod container (containers can nest, e.g. `mod tests`
 * inside an `impl`; the nearest one wins). Function items with no qualifying
 * ancestor (free functions, closures) are not collected — this mirrors the
 * original scope: peer signatures are a within-container concept.
 *
 * Important-finding fix: a `fn` nested inside another `fn`'s body (a local
 * helper) is NOT a peer of the methods around it and must never appear in
 * its container's signature list. Design choice (of the two defensible
 * options — attribute it to its host function as container, or drop it
 * entirely): we exclude it from the symbol list entirely. Rationale: the
 * container's signature list exists to surface *signature* absences across
 * peer methods for a reviewer LLM ("added to `open` but not
 * `open_with_embedder`"); a local helper has no peers by construction
 * (nothing else in the file can call it), so a container built just for it
 * would always yield an empty/pointless peer set. Excluding it is also the
 * pre-existing stated intent above ("fns nested in fns are not collected")
 * — the walker just failed to enforce it because only
 * container nodes pushed a stack frame. `insideFn` tracks that gate: once
 * true, no further function is collected until a nested container (a local
 * `impl`/`mod`/`trait`, however unusual) opens a fresh peer-grouping scope,
 * which is why entering a container always resets it to false.
 */
function collect(
  node: Node,
  src: string,
  stack: ContainerNode[],
  containers: ContainerNode[],
  insideFn: boolean,
): void {
  let pushed = false;
  if (CONTAINER_TYPES.has(node.type)) {
    const container: ContainerNode = { label: headerText(src, node), items: [] };
    containers.push(container);
    stack.push(container);
    pushed = true;
    insideFn = false;
  } else if (FUNCTION_TYPES.has(node.type)) {
    if (!insideFn && stack.length > 0) {
      const nameNode = node.childForFieldName("name");
      stack[stack.length - 1]!.items.push({
        name: nameNode ? nameNode.text : "",
        kind: "fn",
        signature: headerText(src, node),
        startRow: node.startPosition.row,
        endRow: node.endPosition.row,
      });
    }
    // Anything nested inside this function's body — whether or not the
    // function itself was collected — is nested-in-a-function.
    insideFn = true;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) collect(child, src, stack, containers, insideFn);
  }

  if (pushed) stack.pop();
}

/**
 * Whether `item`'s row range was touched by the diff. Thin, item-shaped
 * adapter over the shared `rangeTouched` (see hunks.ts for the deletion-gap
 * resolution rationale, moved there in Task 4's review so lint.ts's clippy
 * spans can reuse the exact same "did the diff touch this row range" logic
 * instead of only checking file membership).
 */
function isTouched(item: Item, changed: ChangedLines): boolean {
  return rangeTouched(item.startRow, item.endRow, changed);
}

async function extractSymbolsImpl(repo: string, base: string, files: ChangedFile[]): Promise<SymbolResult> {
  const language = await loadLanguage();
  const parser = new Parser();
  parser.setLanguage(language);

  const symbols: SymbolInfo[] = [];
  const containers: ContainerInfo[] = [];
  // `${path}::${container label}` -> the ContainerInfo already emitted for
  // that key, so a second block with the same label (idiomatic Rust: a
  // public `impl Foo` and a separate `impl Foo` for helpers, or two
  // `#[cfg]`-gated blocks) gets its items MERGED into the first one's
  // `signatures`, in source order, rather than silently dropped by a
  // first-block-wins guard. Merging is also the only answer consistent with
  // the pack's own reference scheme: a symbol points at its container by
  // `(path, container)` alone, which cannot distinguish two same-labelled
  // blocks anyway (fix round 1, review finding 1).
  const containerByKey = new Map<string, ContainerInfo>();

  // Fix round 2, review finding 1: the loop below used to skip any block
  // with zero touched items on its own, so a same-labelled block with
  // nothing touched never merged in — invisible to the reviewer, even when
  // a sibling block sharing its key WAS touched. That untouched peer is
  // exactly the case this feature exists to surface (an unamended
  // `open_with_embedder` next to a changed `open`), so per (path, label)
  // key: if ANY block under that key has a touched item, every block
  // sharing the key contributes its signatures, touched or not. A key with
  // no touched block anywhere still never emits a container at all.

  for (const f of files) {
    let src: string;
    try {
      src = readFileSync(join(repo, f.path), "utf8");
    } catch {
      continue;
    }

    const tree = parser.parse(src);
    if (!tree) continue;

    const fileContainers: ContainerNode[] = [];
    collect(tree.rootNode, src, [], fileContainers, false);

    const changed = changedLines(repo, base, f.path);

    // Pass 1: which (path, label) keys have at least one touched item in
    // ANY of their blocks — decided across all blocks sharing the key
    // before any block is skipped, so an untouched block is never judged in
    // isolation.
    const touchedKeys = new Set<string>();
    for (const c of fileContainers) {
      if (c.items.some(item => isTouched(item, changed))) {
        touchedKeys.add(`${f.path}::${c.label}`);
      }
    }

    // Pass 2: emit. A block only contributes (symbols and signatures) if its
    // key is in `touchedKeys`; source order across fileContainers is
    // preserved in the merge, matching the same-block-order guarantee S1
    // established for the both-touched case.
    for (const c of fileContainers) {
      const key = `${f.path}::${c.label}`;
      if (!touchedKeys.has(key)) continue;

      const touched = c.items.filter(item => isTouched(item, changed));
      for (const item of touched) {
        symbols.push({ path: f.path, name: item.name, kind: item.kind, container: c.label });
      }

      const existing = containerByKey.get(key);
      if (existing) {
        existing.signatures.push(...c.items.map(i => i.signature));
      } else {
        const info: ContainerInfo = { path: f.path, container: c.label, signatures: c.items.map(i => i.signature) };
        containerByKey.set(key, info);
        containers.push(info);
      }
    }
  }
  return { symbols, containers };
}

// ===========================================================================
// clippy — moved verbatim from lint.ts
// ===========================================================================

/**
 * `base` is required (not part of `ToolOpts`) because line-level scoping is
 * not optional behavior — see Important finding 1 below.
 */
function runClippyImpl(repo: string, base: string, files: ChangedFile[], opts: ToolOpts = {}): LinterResult {
  const cargo = opts.cargoBin ?? "cargo";
  const degraded: string[] = [];
  if (!have(cargo)) {
    degraded.push(`clippy skipped: ${cargo} not found`);
    return { findings: [] as Finding[], degraded };
  }
  // Important finding 4: probed separately from the bare binary above, so a
  // present-cargo/absent-component toolchain gets its own accurate message
  // instead of falling into the generic "build failed" branch below (a
  // minimal Rust toolchain without the clippy component installed is a
  // plausible, and very different, failure mode from a real compile error).
  if (!have(cargo, "clippy")) {
    degraded.push("clippy skipped: clippy component not installed");
    return { findings: [] as Finding[], degraded };
  }
  const p = spawnGuarded(
    [cargo, "clippy", "--message-format=json", "--quiet"],
    { cwd: repo, env: { ...process.env } },
  );
  // Important finding 3: cargo present and the clippy component present do
  // not guarantee this call succeeds in starting a process at all — a bad
  // `repo` cwd, a TOCTOU race, a permission change, or resource exhaustion
  // can all still make Bun.spawnSync throw synchronously here.
  if (p.threw) {
    degraded.push(`clippy skipped: failed to start (${p.stderr || "unknown error"})`);
    return { findings: [] as Finding[], degraded };
  }
  if (p.exitCode !== 0 && !p.stdout.trim()) {
    degraded.push("clippy skipped: build failed");
    return { findings: [] as Finding[], degraded };
  }
  const changedFilePaths = new Set(files.map(f => f.path));
  const lineCache = new Map<string, ChangedLines>();
  const findings: Finding[] = [];
  for (const line of p.stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let m: any;
    try { m = JSON.parse(line); } catch { continue; }
    const msg = m?.message;
    if (!msg?.spans?.length) continue;
    const span = msg.spans.find((s: any) => s.is_primary) ?? msg.spans[0];
    if (!changedFilePaths.has(span.file_name)) continue; // changed files first
    let cl = lineCache.get(span.file_name);
    if (!cl) {
      cl = changedLines(repo, base, span.file_name);
      lineCache.set(span.file_name, cl);
    }
    const startRow = (span.line_start ?? 1) - 1; // clippy spans are 1-indexed
    const endRow = (span.line_end ?? span.line_start ?? 1) - 1;
    // Important finding 1: changed LINES, not just changed files (§16 noise
    // policy). A diagnostic's span counts as in-scope when it OVERLAPS a
    // row the diff actually touched — any row in [startRow, endRow], not
    // only an exact match on the span's first line — not merely because it
    // lives somewhere in a file the PR happened to touch. A single-line
    // change in a large file used to surface every pre-existing warning in
    // that file; now only diagnostics whose span intersects a touched row
    // (or a resolved pure-deletion gap — see hunks.ts) survive.
    if (!rangeTouched(startRow, endRow, cl)) continue;
    findings.push({
      severity: msg.level === "error" ? "major" : "minor",
      // Minor finding: clippy's JSON carries the individual lint id
      // (`code.code`, e.g. "clippy::eq_op") but never its lint GROUP
      // (correctness/style/perf/...); verified empirically against real
      // `cargo clippy --message-format=json` output (level, code.code,
      // message, children, rendered, spans — no group anywhere). Mapping
      // lint id -> Category would mean hand-maintaining a table of
      // clippy's 700+ individual lints, unversioned and broken by every
      // clippy release. Instead, we use msg.level as a proxy: "error" level
      // corresponds to clippy's deny-by-default "correctness" group, while
      // "warning" level covers style/perf/pedantic and other lints. This is
      // a coarse classification, not an exact group mapping.
      category: msg.level === "error" ? "correctness" : "maintainability",
      path: span.file_name,
      line: span.line_start,
      title: msg.message,
      rationale: msg.message,
      failure_scenario: "reported by cargo clippy",
      suggested_fix: msg.children?.[0]?.message ?? "see clippy output",
      source: "clippy",
      confidence: 1,
    });
  }
  return { findings, degraded };
}

// ===========================================================================
// cargo tools — combined from cargoTools.ts (runApiDelta + runSemverChecks)
// ===========================================================================

function runApiToolsImpl(repo: string, base: string, opts: ToolOpts = {}): ApiToolsResult {
  const cargo = opts.cargoBin ?? "cargo";
  const degraded: string[] = [];
  let apiDelta: string | undefined;
  let semver: Finding[] | undefined;

  // --- runApiDelta (moved verbatim) ---

  if (!have(cargo, "public-api")) {
    degraded.push("cargo public-api unavailable: API-delta section omitted");
  } else {
    const p = spawnGuarded([cargo, "public-api", "diff", `${base}..HEAD`], { cwd: repo });
    // Important finding 3: guard the real invocation — see cargoProbe.ts.
    if (p.threw) {
      degraded.push(`cargo public-api failed to start: API-delta section omitted (${p.stderr || "unknown error"})`);
    } else if (p.exitCode !== 0) {
      degraded.push("cargo public-api failed: API-delta section omitted");
    } else {
      apiDelta = p.stdout;
    }
  }

  // --- runSemverChecks (moved verbatim) ---

  if (!have(cargo, "semver-checks")) {
    degraded.push("cargo semver-checks unavailable: breaking-change section omitted");
  } else {
    const p = spawnGuarded([cargo, "semver-checks", "check-release"], { cwd: repo });
    // Important finding 3: guard the real invocation — see cargoProbe.ts.
    if (p.threw) {
      degraded.push(
        `cargo semver-checks failed to start: breaking-change section omitted (${p.stderr || "unknown error"})`,
      );
    } else if (p.exitCode === 0) {
      semver = [];
    } else {
      const stdout = p.stdout.trim();
      if (!stdout) {
        // Important finding 2: a non-zero exit with nothing on stdout means the
        // tool never produced a report at all — no publishable baseline to
        // compare against, a network failure fetching one from crates.io, or a
        // build/config error. That is "could not run properly," not "found a
        // breaking change," and must degrade rather than fabricate a
        // merge-blocking Finding for a check that never validly ran. The real
        // error typically lands on stderr, which the old code never read.
        const detail = p.stderr.trim();
        degraded.push(`cargo semver-checks failed to run: ${detail || "no output on stdout or stderr"}`);
      } else {
        semver = [{
          severity: "major", category: "api-contract",
          path: "Cargo.toml", line: 1,
          title: "cargo semver-checks reported a breaking change",
          rationale: stdout.slice(0, 2000),
          failure_scenario: "downstream consumers fail to compile after upgrading",
          suggested_fix: "bump the major version, or restore the removed API",
          source: "semver", confidence: 1,
        }];
      }
    }
  }

  return { apiDelta, semver, degraded };
}

// ===========================================================================
// the module
// ===========================================================================

/**
 * Detects a Rust project. Checks for a root `Cargo.toml` first (the common
 * case). Falls back to a shallow search for nested manifests (e.g.
 * `backend/Cargo.toml` in a monorepo) so these repos are not silently
 * degraded to a generic review. Falls back further to changed `.rs` files
 * (the last-resort signal a project uses Rust without a standard layout).
 */
function detectRust(repo: string): boolean {
  // Root manifest — the common case.
  if (existsSync(join(repo, "Cargo.toml"))) return true;
  // Nested manifest (one level deep, e.g. `backend/Cargo.toml`).
  try {
    for (const entry of readdirSync(repo)) {
      const subdir = join(repo, entry);
      const stat = statSync(subdir);
      if (!stat.isDirectory() || entry.startsWith(".") || entry === "target" || entry === "node_modules") continue;
      if (existsSync(join(subdir, "Cargo.toml"))) return true;
    }
  } catch { /* ignore readdir errors — fall through */ }
  return false;
}

export const rust: LanguageModule = {
  name: "rust",
  detect: detectRust,
  filePattern: "*.rs",
  extractSymbols: extractSymbolsImpl,
  runLinters: runClippyImpl,
  runApiTools: runApiToolsImpl,
  readSymbolPattern: SYMBOL_PATTERNS.rust,
};
