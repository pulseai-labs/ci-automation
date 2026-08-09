import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language, type Node } from "web-tree-sitter";
import type { ChangedFile, SymbolInfo } from "../types";

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
 * original scope: siblings are a within-container concept.
 *
 * Important-finding fix: a `fn` nested inside another `fn`'s body (a local
 * helper) is NOT a peer of the methods around it and must never appear in
 * their `siblings`. Design choice (of the two defensible options — attribute
 * it to its host function as container, or drop it entirely): we exclude it
 * from the symbol list entirely. Rationale: `siblings` exists to surface
 * *signature* absences across peer methods for a reviewer LLM ("added to
 * `open` but not `open_with_embedder`"); a local helper has no peers by
 * construction (nothing else in the file can call it), so a container built
 * just for it would always yield an empty/pointless sibling set. Excluding
 * it is also the pre-existing stated intent above ("fns nested in fns are
 * not collected") — the walker just failed to enforce it because only
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
 * A deletion-only hunk (`@@ -l,s +n,0 @@`) leaves a "gap" in the new file
 * between two surviving lines. `before` is the last surviving line ahead of
 * the gap (0-indexed new-file row; `null` when the gap is at the very start
 * of the file, so there is no preceding line) and `after` is the first
 * surviving line behind it.
 */
interface DeletionGap {
  before: number | null;
  after: number;
}

interface ChangedLines {
  /** rows carrying real new-side content (added or context lines) — 0-indexed */
  rows: Set<number>;
  deletionGaps: DeletionGap[];
}

/**
 * Lines touched by the diff, as 0-indexed new-file row numbers, plus the
 * gap anchors of any pure-deletion hunks (resolved against the AST later, in
 * `isTouched` — see that function for why).
 *
 * Critical fix: a pure-deletion hunk (`@@ -l,s +n,0 @@`) has nothing on the
 * new side, so it used to contribute nothing to the touched set — making a
 * deleted call inside an otherwise-untouched function structurally invisible
 * (the enclosing function's row range never intersected `touched`, so
 * `extractSymbols` silently dropped it).
 *
 * Git's convention for a `+n,0` hunk is that `n` is the new-file line
 * immediately BEFORE the gap left by the deletion (0 when the gap is at the
 * very start of the file); the line immediately AFTER the gap is `n+1`.
 */
function changedLines(repo: string, base: string, path: string): ChangedLines {
  const p = Bun.spawnSync(["git", "diff", "-U0", `${base}...HEAD`, "--", path], { cwd: repo });
  const out = p.stdout.toString();
  const rows = new Set<number>();
  const deletionGaps: DeletionGap[] = [];
  for (const m of out.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) {
      deletionGaps.push({
        before: start > 0 ? start - 1 : null, // 0-indexed, or no preceding line
        after: start, // 0-indexed
      });
      continue;
    }
    for (let i = 0; i < count; i++) rows.add(start + i - 1); // 0-indexed
  }
  return { rows, deletionGaps };
}

/**
 * Important-finding fix: a pure-deletion gap used to register BOTH of its
 * anchors as independently "touched," so a deletion sitting *between* two
 * functions (e.g. an interstitial comment) landed one anchor on the
 * preceding function's last row and the other on the following function's
 * first row — falsely marking both changed although neither's own content
 * changed.
 *
 * Fix: resolve the gap against the AST. The deletion point sits strictly
 * inside a single item's row range only when BOTH surviving anchors do —
 * since an item's rows are contiguous, that is exactly the condition for
 * the gap to fall in its interior rather than at a boundary shared with a
 * neighbour (or outside any item, e.g. between a container's opening brace
 * and its first member).
 */
function isTouched(item: Item, changed: ChangedLines): boolean {
  for (const l of changed.rows) {
    if (l >= item.startRow && l <= item.endRow) return true;
  }
  for (const gap of changed.deletionGaps) {
    const beforeIn = gap.before !== null && gap.before >= item.startRow && gap.before <= item.endRow;
    const afterIn = gap.after >= item.startRow && gap.after <= item.endRow;
    if (beforeIn && afterIn) return true;
  }
  return false;
}

export async function extractSymbols(repo: string, base: string, files: ChangedFile[]): Promise<SymbolInfo[]> {
  const language = await loadLanguage();
  const parser = new Parser();
  parser.setLanguage(language);

  const out: SymbolInfo[] = [];
  for (const f of files) {
    let src: string;
    try {
      src = readFileSync(join(repo, f.path), "utf8");
    } catch {
      continue;
    }

    const tree = parser.parse(src);
    if (!tree) continue;

    const containers: ContainerNode[] = [];
    collect(tree.rootNode, src, [], containers, false);

    const changed = changedLines(repo, base, f.path);

    for (const c of containers) {
      for (const item of c.items) {
        if (!isTouched(item, changed)) continue;
        out.push({
          path: f.path,
          name: item.name,
          kind: item.kind,
          container: c.label,
          siblings: c.items.filter(s => s !== item).map(s => s.signature),
        });
      }
    }
  }
  return out;
}
