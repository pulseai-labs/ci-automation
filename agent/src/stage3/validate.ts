import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { Category, EvidencePack, Finding, Severity } from "../types";

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
 *
 * Deletion-only hunk semantic (deliberate, with a gating consequence):
 * ONLY '+' lines call `.add(newLine)` — a ' ' context line advances
 * `newLine` but is never marked touched. A hunk that only removes lines
 * (no '+' lines of its own) therefore marks nothing touched for that hunk,
 * even though the surrounding context lines the diff prints around it DO
 * exist in `touched`'s keyspace via other hunks. Consequence: an
 * agent-authored finding that cites a line adjacent to a pure deletion
 * (e.g. "the line after the one you deleted now needs updating") can never
 * be `adjacent: false` on that basis alone — it always reads as
 * pre-existing and never gates purely from a deletion. This is intentional
 * (the new-side line-number space has no line that corresponds to "the
 * thing that was deleted"), not an oversight; a finding about the
 * deletion's effect must cite a '+' line or an actually-changed line to
 * gate.
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

/**
 * Repo-relative POSIX spelling of `path` — the SAME normalization the main
 * loop below applies to every finding it keeps, exposed here so
 * `deterministicKeys` (built from clippy/semver findings, before the main
 * loop runs) can be keyed on it too. Without this, an agent finding spelled
 * "./src/a.rs" would never dedupe against a clippy finding spelled
 * "src/a.rs" — `key()` is a plain string template, and the two spellings
 * are different strings.
 */
function normalizeRel(repoRoot: string, path: string): string {
  return relative(repoRoot, resolve(repoRoot, path)).split(sep).join("/");
}

/**
 * Stable, model-independent identifier for why a finding was dropped — one
 * per drop site below. `why` (kept alongside `code` on each dropped entry)
 * stays free text for logs/debugging, but four of the six `why` strings
 * interpolate `f.path` (and `line-out-of-range` also interpolates `f.line`
 * and the file's line count), so `why` is itself partly model-controlled —
 * a model can make it arbitrarily long or numerous just by inventing more
 * distinct paths. `code` never varies with the finding's content, so a
 * caller that needs to summarize drops (stage3/index.ts's `finalize()`)
 * can bound the summary's size regardless of what the model returns.
 */
export type DropCode =
  | "invalid-severity"
  | "invalid-category"
  | "path-escapes-repo"
  | "path-missing"
  | "not-a-regular-file"
  | "line-out-of-range"
  | "duplicate-of-deterministic"
  | "duplicate";

const VALID_SEVERITIES: ReadonlySet<Severity> = new Set(["blocker", "major", "minor", "nit"]);
const VALID_CATEGORIES: ReadonlySet<Category> = new Set([
  "correctness", "security", "data-loss", "api-contract", "maintainability",
]);

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
): { kept: Finding[]; dropped: { finding: Finding; why: string; code: DropCode }[] } {
  const touched = diffLines(pack.diff);
  const repoRoot = resolve(repo);
  // N1: keyed on the SAME normalized path the main loop below uses for
  // `nf` — see normalizeRel()'s own comment.
  const deterministicKeys = new Set(
    [...pack.clippy, ...(pack.semver ?? [])].map(f => key({ ...f, path: normalizeRel(repoRoot, f.path) })),
  );

  const kept: Finding[] = [];
  const dropped: { finding: Finding; why: string; code: DropCode }[] = [];
  const seen = new Set<string>();

  for (const f of findings) {
    // Schema drift guard: nothing upstream of validate() checks enum
    // membership, and an off-enum severity falls straight through
    // deriveVerdict's `gateOn.includes(f.severity)` to `false` — i.e. a
    // gate that fails OPEN (silently PASSes) rather than closed when a
    // finding's severity or category doesn't match the typed union.
    // validate() is the one chokepoint every finding passes through
    // regardless of origin (agent, clippy, semver), so it is the right
    // place to catch this rather than trusting the model (or a future
    // deterministic source) to only ever emit the four/five known values.
    if (!VALID_SEVERITIES.has(f.severity)) {
      dropped.push({ finding: f, why: `invalid severity: ${f.severity}`, code: "invalid-severity" });
      continue;
    }
    if (!VALID_CATEGORIES.has(f.category)) {
      dropped.push({ finding: f, why: `invalid category: ${f.category}`, code: "invalid-category" });
      continue;
    }
    const abs = resolve(repo, f.path);
    if (abs !== repoRoot && !abs.startsWith(repoRoot + sep)) {
      dropped.push({ finding: f, why: `path escapes repo: ${f.path}`, code: "path-escapes-repo" });
      continue;
    }
    // Normalize once to a repo-relative POSIX path and reuse it for every
    // downstream check — the diff-adjacency lookup below, the DEDUPE keys
    // (N1: a previous version of this fix normalized only the adjacency
    // lookup and the stored path, leaving `key()` — used for both the
    // deterministic-duplicate check and the same-list `seen` dedupe —
    // still keyed on the raw, unnormalized `f.path`; two spellings of one
    // finding, e.g. "src/a.rs" and "./src/a.rs", produced two different
    // dedupe keys and both survived into `kept`, double-counting a gating
    // finding with no drop recorded at all — a fail-OPEN, not fail-closed),
    // and the path stored on the kept finding. `touched` (from
    // diffLines()) is keyed by the diff's own canonical spelling (e.g.
    // "src/a.rs"); a model emitting an equivalent but differently-spelled
    // path resolves to the same file for the filesystem checks below via
    // `resolve()`, but as a RAW STRING it would never equal a `touched` key
    // or another finding's dedupe key.
    //
    // `nf` ("normalized finding") is what every downstream key/lookup uses
    // from here on; `f` (the raw, model-supplied finding) is kept only for
    // the `why` messages below, which deliberately echo back what the
    // model actually wrote.
    const relPath = relative(repoRoot, abs).split(sep).join("/");
    const nf: Finding = { ...f, path: relPath };
    if (!existsSync(abs)) {
      dropped.push({ finding: f, why: `path does not exist at head: ${f.path}`, code: "path-missing" });
      continue;
    }
    if (!statSync(abs).isFile()) {
      dropped.push({ finding: f, why: `path is not a regular file: ${f.path}`, code: "not-a-regular-file" });
      continue;
    }
    const lines = countLines(readFileSync(abs, "utf8"));
    // M-2: a fractional (or NaN) line like 2.5 passes both bounds checks
    // (2.5 >= 1 && 2.5 <= lines), is never in `touched` (integer keys), and
    // renders as "path:2.5". Number.isInteger also rejects NaN/Infinity,
    // which the bare bounds check alone admits.
    if (!Number.isInteger(f.line) || f.line < 1 || f.line > lines) {
      dropped.push({ finding: f, why: `line ${f.line} outside ${f.path} (${lines} lines)`, code: "line-out-of-range" });
      continue;
    }
    // Only a model-authored finding can be a duplicate OF a deterministic one.
    // Applying this to clippy/semver findings themselves would drop every one of
    // them, since deterministicKeys is built from exactly those findings.
    // Keyed on `nf` (normalized path), not `f` — see the comment above.
    if (f.source === "agent" && deterministicKeys.has(key(nf))) {
      dropped.push({ finding: f, why: "duplicate of a deterministic finding", code: "duplicate-of-deterministic" });
      continue;
    }
    if (seen.has(key(nf))) {
      dropped.push({ finding: f, why: "duplicate finding", code: "duplicate" });
      continue;
    }
    seen.add(key(nf));
    // C1: only a MODEL-AUTHORED finding's adjacency is re-decided here.
    // `clippy` and `semver` findings are deterministic tool output that
    // stage 1 already scoped correctly — clippy via `rangeTouched` (line-
    // level overlap against the real diff, agent/src/stage1/lint.ts), and
    // semver findings are repo-level by construction (they pin
    // "Cargo.toml:1", a file diff.ts's *.rs-only `git diff` invocation can
    // never touch, so `touched` can never contain it as a key). Re-running
    // this file's own, text-parsed, byte-capped `touched` map over them can
    // only ever LOSE information stage 1 already had right: it would mark
    // every semver finding `adjacent: true` (Cargo.toml is never a
    // `touched` key), permanently defeating the api-contract gate, and it
    // would downgrade a clippy span whose `line` (line_start) lands on a
    // context row even though the span, correctly, overlaps a changed one.
    kept.push({
      ...nf,
      adjacent: f.source === "agent" ? !(touched.get(relPath)?.has(f.line) ?? false) : false,
    });
  }
  return { kept, dropped };
}
