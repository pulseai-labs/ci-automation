import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { EvidencePack, Finding } from "../types";

/**
 * Line numbers touched by the diff, per file — new-side ("+") lines only.
 *
 * Walks each hunk's BODY tracking the new-side line counter (advances on
 * ' ' context and '+' added lines, not on '-' removed lines) instead of
 * blindly expanding the hunk header's declared range. Stage 1 emits `git
 * diff -U5` (agent/src/stage1/diff.ts:48), so a real hunk carries up to 5
 * context lines on each side of a change — expanding the header range would
 * mark every one of those context lines as "touched", which would make any
 * finding within 5 lines of a real change gate the merge even though it
 * isn't actually on a changed line.
 *
 * A `+++ b/<path>` line is accepted as a file header only immediately after
 * a `--- ` line — never mid-hunk. Added source content that happens to
 * start with `++ b/decoy.rs` (legal inside a Rust comment or raw string)
 * renders, with its `+` diff prefix, as a line that looks exactly like a
 * `+++` file header; matching it unconditionally would re-point `file` for
 * every later hunk to the decoy path, letting the PR author's own
 * subsequent changes come back `adjacent: true` and stop gating.
 *
 * A diff can be cut off mid-hunk by stage 1's byte cap (see `cap()` in
 * agent/src/stage1/diff.ts). This walk never assumes a hunk is complete —
 * an early end of input just stops counting, it never throws.
 */
function diffLines(diff: string): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  let file = "";
  let inHunk = false;
  let newLine = 0;
  let afterDashHeader = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = "";
      inHunk = false;
      afterDashHeader = false;
      continue;
    }

    const hm = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hm) {
      newLine = Number(hm[1]);
      inHunk = true;
      afterDashHeader = false;
      continue;
    }

    if (inHunk) {
      if (line.startsWith("+")) {
        if (file) map.get(file)!.add(newLine);
        newLine++;
      } else if (line.startsWith(" ")) {
        newLine++;
      }
      // '-' lines (old side only) and anything else (a "\ No newline at end
      // of file" marker, or a line the byte cap cut mid-hunk): no advance,
      // no touch, no throw.
      continue;
    }

    // Outside a hunk body — the only place `file` may change.
    if (line.startsWith("--- ")) {
      afterDashHeader = true;
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (afterDashHeader) {
        const fm = line.match(/^\+\+\+ b\/(.+)$/);
        file = fm ? fm[1] : ""; // "+++ /dev/null" (deleted file): no file
        if (file) map.set(file, map.get(file) ?? new Set());
      }
      afterDashHeader = false;
      continue;
    }
    afterDashHeader = false;
  }
  return map;
}

const key = (f: Finding) => `${f.path}:${f.line}:${f.category}`;

/** Number of real lines in `content` (a trailing newline is not a phantom extra line; an empty file is 0 lines). */
function countLines(content: string): number {
  if (content === "") return 0;
  const stripped = content.endsWith("\n") ? content.slice(0, -1) : content;
  return stripped === "" ? 0 : stripped.split("\n").length;
}

export function validate(
  findings: Finding[],
  pack: EvidencePack,
  repo: string,
): { kept: Finding[]; dropped: { finding: Finding; why: string }[] } {
  const touched = diffLines(pack.diff);
  const deterministicKeys = new Set([...pack.clippy, ...(pack.semver ?? [])].map(key));
  const repoRoot = resolve(repo);

  const kept: Finding[] = [];
  const dropped: { finding: Finding; why: string }[] = [];
  const seen = new Set<string>();

  for (const f of findings) {
    const abs = resolve(repo, f.path);
    if (abs !== repoRoot && !abs.startsWith(repoRoot + sep)) {
      dropped.push({ finding: f, why: `path escapes repo: ${f.path}` });
      continue;
    }
    if (!existsSync(abs)) {
      dropped.push({ finding: f, why: `path does not exist at head: ${f.path}` });
      continue;
    }
    if (!statSync(abs).isFile()) {
      dropped.push({ finding: f, why: `path is not a regular file: ${f.path}` });
      continue;
    }
    const lines = countLines(readFileSync(abs, "utf8"));
    if (f.line < 1 || f.line > lines) {
      dropped.push({ finding: f, why: `line ${f.line} outside ${f.path} (${lines} lines)` });
      continue;
    }
    // Only a model-authored finding can be a duplicate OF a deterministic one.
    // Applying this to clippy/semver findings themselves would drop every one of
    // them, since deterministicKeys is built from exactly those findings.
    if (f.source === "agent" && deterministicKeys.has(key(f))) {
      dropped.push({ finding: f, why: "duplicate of a deterministic finding" });
      continue;
    }
    if (seen.has(key(f))) {
      dropped.push({ finding: f, why: "duplicate finding" });
      continue;
    }
    seen.add(key(f));
    kept.push({ ...f, adjacent: !(touched.get(f.path)?.has(f.line) ?? false) });
  }
  return { kept, dropped };
}
