import type { ChangedFile, Finding } from "../types";
import { have, spawnGuarded, type ToolOpts } from "./cargoProbe";
import { changedLines, rangeTouched, type ChangedLines } from "./hunks";

export type { ToolOpts };

/**
 * `base` is required (not part of `ToolOpts`) because line-level scoping is
 * not optional behavior — see Important finding 1 below.
 */
export function runClippy(repo: string, base: string, files: ChangedFile[], opts: ToolOpts = {}) {
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
