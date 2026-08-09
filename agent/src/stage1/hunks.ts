/**
 * Diff-hunk parsing shared by symbols.ts (AST-node touch detection) and
 * lint.ts (clippy diagnostic-span touch detection). Extracted from
 * symbols.ts (Task 4 review, Important finding 1): lint.ts used to
 * implement its own, much weaker, notion of "changed" — file membership
 * only — which kept every pre-existing diagnostic in a touched file, not
 * just the ones on lines the PR actually modified. Both consumers now share
 * one row-range "was this touched by the diff" primitive instead of lint.ts
 * quietly reinventing (and under-scoping) it.
 */

/**
 * A deletion-only hunk (`@@ -l,s +n,0 @@`) leaves a "gap" in the new file
 * between two surviving lines. `before` is the last surviving line ahead of
 * the gap (0-indexed new-file row; `null` when the gap is at the very start
 * of the file, so there is no preceding line) and `after` is the first
 * surviving line behind it.
 */
export interface DeletionGap {
  before: number | null;
  after: number;
}

export interface ChangedLines {
  /** rows carrying real new-side content (added or context lines) — 0-indexed */
  rows: Set<number>;
  deletionGaps: DeletionGap[];
}

/**
 * Lines touched by the diff, as 0-indexed new-file row numbers, plus the
 * gap anchors of any pure-deletion hunks (resolved against a row range
 * later, in `rangeTouched` — see that function for why).
 *
 * Critical fix (Task 3): a pure-deletion hunk (`@@ -l,s +n,0 @@`) has nothing
 * on the new side, so it used to contribute nothing to the touched set —
 * making a deleted call inside an otherwise-untouched function structurally
 * invisible (the enclosing function's row range never intersected the
 * touched rows, so the caller silently dropped it).
 *
 * Git's convention for a `+n,0` hunk is that `n` is the new-file line
 * immediately BEFORE the gap left by the deletion (0 when the gap is at the
 * very start of the file); the line immediately AFTER the gap is `n+1`.
 */
export function changedLines(repo: string, base: string, path: string): ChangedLines {
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
 * True when the 0-indexed, inclusive row range `[startRow, endRow]` was
 * touched by the diff described in `changed`. Used both for an AST item's
 * row range (symbols.ts) and a clippy diagnostic's span (lint.ts) — the same
 * question ("did the diff touch any row this range covers") applies to both.
 *
 * Two ways a range counts as touched:
 *
 *  1. It directly contains a changed row (`changed.rows`). This alone is
 *     OVERLAP semantics, not exact-match: the range counts as touched if ANY
 *     row inside it changed, not only its first row — e.g. a clippy span
 *     covering lines 8-12 where only line 10 changed still counts, and an
 *     AST item spanning many lines counts as soon as one of them changed.
 *
 *  2. Important-finding fix (Task 3): a pure-deletion gap sitting strictly
 *     INSIDE the range (both surviving anchors within it) counts too — since
 *     a range is contiguous, that is exactly the condition for the deletion
 *     to fall in the range's interior rather than at a boundary shared with
 *     a neighbour. A gap where only one anchor falls inside the range (e.g.
 *     a deletion sitting between two functions) must NOT count for either
 *     neighbour — neither one's own content changed.
 */
export function rangeTouched(startRow: number, endRow: number, changed: ChangedLines): boolean {
  for (const l of changed.rows) {
    if (l >= startRow && l <= endRow) return true;
  }
  for (const gap of changed.deletionGaps) {
    const beforeIn = gap.before !== null && gap.before >= startRow && gap.before <= endRow;
    const afterIn = gap.after >= startRow && gap.after <= endRow;
    if (beforeIn && afterIn) return true;
  }
  return false;
}
