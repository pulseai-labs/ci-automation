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
 * ancestor (free functions, closures, fns nested in fns) are not collected —
 * this mirrors the original scope: siblings are a within-container concept.
 */
function collect(node: Node, src: string, stack: ContainerNode[], containers: ContainerNode[]): void {
  let pushed = false;
  if (CONTAINER_TYPES.has(node.type)) {
    const container: ContainerNode = { label: headerText(src, node), items: [] };
    containers.push(container);
    stack.push(container);
    pushed = true;
  } else if (FUNCTION_TYPES.has(node.type) && stack.length > 0) {
    const nameNode = node.childForFieldName("name");
    stack[stack.length - 1]!.items.push({
      name: nameNode ? nameNode.text : "",
      kind: "fn",
      signature: headerText(src, node),
      startRow: node.startPosition.row,
      endRow: node.endPosition.row,
    });
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) collect(child, src, stack, containers);
  }

  if (pushed) stack.pop();
}

/**
 * Lines touched by the diff, as 0-indexed new-file row numbers.
 *
 * Critical fix: a pure-deletion hunk (`@@ -l,s +n,0 @@`) has nothing on the
 * new side, so it used to contribute nothing to the touched set — making a
 * deleted call inside an otherwise-untouched function structurally invisible
 * (the enclosing function's row range never intersected `touched`, so
 * `extractSymbols` silently dropped it).
 *
 * Git's convention for a `+n,0` hunk is that `n` is the new-file line
 * immediately BEFORE the gap left by the deletion; the line immediately
 * AFTER the gap is `n+1`. The enclosing item still exists (just shorter), so
 * registering both anchors as touched (0-indexed: n-1 and n) guarantees one
 * of them falls inside that item's row range.
 */
function changedLines(repo: string, base: string, path: string): Set<number> {
  const p = Bun.spawnSync(["git", "diff", "-U0", `${base}...HEAD`, "--", path], { cwd: repo });
  const out = p.stdout.toString();
  const set = new Set<number>();
  for (const m of out.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) {
      set.add(start - 1); // last surviving line before the gap (0-indexed)
      set.add(start); // first surviving line after the gap (0-indexed)
      continue;
    }
    for (let i = 0; i < count; i++) set.add(start + i - 1); // 0-indexed
  }
  return set;
}

function isTouched(item: Item, touched: Set<number>): boolean {
  for (const l of touched) {
    if (l >= item.startRow && l <= item.endRow) return true;
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
    collect(tree.rootNode, src, [], containers);

    const touched = changedLines(repo, base, f.path);

    for (const c of containers) {
      for (const item of c.items) {
        if (!isTouched(item, touched)) continue;
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
