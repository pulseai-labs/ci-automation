import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangedFile, SymbolInfo } from "../types";

interface Item { name: string; kind: string; signature: string; start: number; end: number }
interface Container { label: string; start: number; end: number; items: Item[] }

const FN_RE = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/;
const CONTAINER_RE = /^\s*(impl(?:\s+[^{]*)?|mod\s+[A-Za-z_][A-Za-z0-9_]*|trait\s+[A-Za-z_][A-Za-z0-9_]*)\s*\{/;

/** Brace-matching parse. Deliberately not tree-sitter: every tree-sitter tool is
 *  #[cfg]-blind, and we only need containers + signatures (spec §10). */
function parse(src: string): Container[] {
  const lines = src.split("\n");
  const containers: Container[] = [];
  let depth = 0;
  let current: Container | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const cm = line.match(CONTAINER_RE);
    if (cm && depth === 0) {
      current = { label: cm[1].trim().replace(/\s+/g, " "), start: i, end: -1, items: [] };
      containers.push(current);
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      continue;
    }
    if (current) {
      const fm = line.match(FN_RE);
      if (fm && depth === 1) {
        const sig = line.trim().replace(/\s*\{\s*$/, "").replace(/\s+/g, " ");
        current.items.push({ name: fm[1], kind: "fn", signature: sig, start: i, end: i });
      }
      const before = depth;
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      if (current.items.length) {
        const last = current.items[current.items.length - 1];
        if (before >= 1) last.end = i;
      }
      if (depth === 0) { current.end = i; current = null; }
    }
  }
  return containers;
}

function changedLines(repo: string, base: string, path: string): Set<number> {
  const p = Bun.spawnSync(["git", "diff", "-U0", `${base}...HEAD`, "--", path], { cwd: repo });
  const out = p.stdout.toString();
  const set = new Set<number>();
  for (const m of out.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count; i++) set.add(start + i - 1); // 0-indexed
  }
  return set;
}

export function extractSymbols(repo: string, base: string, files: ChangedFile[]): SymbolInfo[] {
  const out: SymbolInfo[] = [];
  for (const f of files) {
    let src: string;
    try { src = readFileSync(join(repo, f.path), "utf8"); } catch { continue; }
    const containers = parse(src);
    const touched = changedLines(repo, base, f.path);

    for (const c of containers) {
      for (const item of c.items) {
        let hit = false;
        for (let l = item.start; l <= Math.max(item.end, item.start); l++) {
          if (touched.has(l)) { hit = true; break; }
        }
        if (!hit) continue;
        out.push({
          path: f.path,
          name: item.name,
          kind: item.kind,
          container: c.label,
          siblings: c.items.filter(s => s.name !== item.name).map(s => s.signature),
        });
      }
    }
  }
  return out;
}
