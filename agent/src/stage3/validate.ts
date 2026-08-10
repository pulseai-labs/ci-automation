import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvidencePack, Finding } from "../types";

/** Line numbers touched by the diff, per file. */
function diffLines(diff: string): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  let file = "";
  for (const line of diff.split("\n")) {
    const fm = line.match(/^\+\+\+ b\/(.+)$/);
    if (fm) { file = fm[1]; map.set(file, map.get(file) ?? new Set()); continue; }
    const hm = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hm && file) {
      const start = Number(hm[1]);
      const count = hm[2] === undefined ? 1 : Number(hm[2]);
      const set = map.get(file)!;
      for (let i = 0; i < count; i++) set.add(start + i);
    }
  }
  return map;
}

const key = (f: Finding) => `${f.path}:${f.line}:${f.category}`;

export function validate(findings: Finding[], pack: EvidencePack, repo: string) {
  const touched = diffLines(pack.diff);
  const deterministicKeys = new Set([...pack.clippy, ...(pack.semver ?? [])].map(key));

  const kept: Finding[] = [];
  const dropped: { finding: Finding; why: string }[] = [];
  const seen = new Set<string>();

  for (const f of findings) {
    const abs = join(repo, f.path);
    if (!existsSync(abs)) { dropped.push({ finding: f, why: `path does not exist at head: ${f.path}` }); continue; }
    const lines = readFileSync(abs, "utf8").split("\n").length;
    if (f.line < 1 || f.line > lines) { dropped.push({ finding: f, why: `line ${f.line} outside ${f.path} (${lines} lines)` }); continue; }
    // Only a model-authored finding can be a duplicate OF a deterministic one.
    // Applying this to clippy/semver findings themselves would drop every one of
    // them, since deterministicKeys is built from exactly those findings.
    if (f.source === "agent" && deterministicKeys.has(key(f))) {
      dropped.push({ finding: f, why: "duplicate of a deterministic finding" });
      continue;
    }
    if (seen.has(key(f))) { dropped.push({ finding: f, why: "duplicate finding" }); continue; }
    seen.add(key(f));
    kept.push({ ...f, adjacent: !(touched.get(f.path)?.has(f.line) ?? false) });
  }
  return { kept, dropped };
}
