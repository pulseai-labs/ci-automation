import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { cap } from "../../stage1/diff";

/**
 * `read_symbol` — the pure, server-free implementation.
 *
 * Returns the body of ONE Rust function named `name` in `repo/path`. The body
 * is bounded by brace-matching from the `fn` declaration line. Output is
 * byte-capped via `cap()` so a huge function can never return unbounded bytes.
 *
 * KNOWN LIMITATION (deliberate, do NOT fix here): brace-counting desyncs on
 * string/comment literals that contain `{` or `}`. Task 3 of this branch fixed
 * the signature extractor by switching to tree-sitter, but `read_symbol` is a
 * best-effort reader the model invokes on demand — slightly imperfect boundaries
 * are tolerable because the model can absorb a few extra/missing lines. Adding
 * tree-sitter here would pull a heavy dependency into a tool that runs inside
 * the untrusted-session server for no real gain.
 */
export function readSymbolImpl(repo: string, path: string, name: string, capBytes: number): string {
  const root = resolve(repo);
  const abs = resolve(join(repo, path));
  if (!abs.startsWith(root + "/") && abs !== root) {
    throw new Error(`refused: ${path} resolves outside the repository root`);
  }
  const src = readFileSync(abs, "utf8");
  const lines = src.split("\n");
  const re = new RegExp(`\\bfn\\s+${name}\\b`);

  let start = -1;
  for (let i = 0; i < lines.length; i++) { if (re.test(lines[i])) { start = i; break; } }
  if (start === -1) return `[not found: no fn ${name} in ${path}]`;

  let depth = 0, seen = false, end = start;
  for (let i = start; i < lines.length; i++) {
    depth += (lines[i].match(/\{/g) ?? []).length - (lines[i].match(/\}/g) ?? []).length;
    if ((lines[i].match(/\{/g) ?? []).length) seen = true;
    end = i;
    if (seen && depth <= 0) break;
  }
  const body = lines.slice(start, end + 1).join("\n");
  return cap(body, capBytes).text;
}
