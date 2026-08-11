import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language, type Node } from "web-tree-sitter";
import type { ChangedFile, ContainerInfo, SymbolInfo } from "../types";
import { changedLines, rangeTouched, type ChangedLines } from "./hunks";

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

export interface SymbolExtraction {
  symbols: SymbolInfo[];
  containers: ContainerInfo[];
}

export async function extractSymbols(repo: string, base: string, files: ChangedFile[]): Promise<SymbolExtraction> {
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
