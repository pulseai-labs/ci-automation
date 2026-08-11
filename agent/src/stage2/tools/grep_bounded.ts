import { cap } from "../../stage1/diff";

/**
 * `grep_bounded` — the pure, server-free implementation.
 *
 * Shells out to `grep -rn` with a per-file match cap (`-m 40`) and a glob filter
 * (`--include`), then byte-caps the aggregate output via `cap()`. This is the
 * single change that prevents unbounded tool output: even a pattern that matches
 * thousands of lines is capped to `capBytes` with a truncation marker reporting
 * the real size.
 *
 * Returns `[no matches ...]` when grep finds nothing, so the model never sees an
 * empty string (which it might mistake for an error).
 */
export function grepBoundedImpl(repo: string, pattern: string, glob: string, capBytes: number): string {
  const p = Bun.spawnSync(
    ["grep", "-rn", "--include", glob, "-m", "40", "-e", pattern, "."],
    { cwd: repo },
  );
  const out = p.stdout.toString();
  if (!out.trim()) return `[no matches for ${pattern} in ${glob}]`;
  return cap(out, capBytes).text;
}
