/**
 * Cargo-tool detection and invocation shared by lint.ts and cargoTools.ts.
 * Consolidated here (Task 4 review, Important finding 4): `lint.ts` and
 * `cargoTools.ts` each carried their own `have()`, and they had already
 * diverged — lint.ts's checked only `command -v cargo`, so `runClippy`
 * could not tell "cargo present but the clippy component missing" apart
 * from "cargo present but the build failed." One helper, one place.
 */

export interface ToolOpts { cargoBin?: string; timeoutMs?: number }

/**
 * Whether `bin` (optionally its `sub`command, e.g. "clippy" or
 * "public-api") is available. With `sub`, probes `<bin> <sub> --version` —
 * this is what actually distinguishes "cargo is installed but the
 * component isn't" from "cargo itself is missing," which a bare
 * `command -v cargo` cannot do.
 *
 * Wrapped in try/catch for the same reason every real invocation in this
 * module is (Important finding 3): `Bun.spawnSync` throws synchronously,
 * rather than returning a failed result, when the process cannot be
 * started at all. A probe that can't run is exactly as informative as one
 * that fails, so a throw here is just another "not available."
 */
export function have(bin: string, sub?: string): boolean {
  const cmd = sub ? `${bin} ${sub} --version` : `command -v ${bin}`;
  try {
    return Bun.spawnSync(["bash", "-lc", cmd]).exitCode === 0;
  } catch {
    return false;
  }
}

export interface SpawnOutcome {
  /**
   * True only when the OS could not start the process at all —
   * `Bun.spawnSync` threw synchronously instead of returning a result.
   * Empirically reproducible with a nonexistent `cwd` (Important finding
   * 3); a bad cwd, a TOCTOU race between the `have()` probe and the real
   * call, a permission change, or resource exhaustion can all land here
   * even after `have()` passed. Kept distinct from a real process that ran
   * and exited non-zero (`threw: false`) so callers can report an accurate
   * degrade message instead of misreporting a spawn failure as, say,
   * "build failed."
   */
  threw: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a real tool invocation without ever throwing — this module's
 * contract (§5: degrade, don't fail) requires every code path to return
 * normally, and `Bun.spawnSync` does not honor that on its own.
 */
export function spawnGuarded(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): SpawnOutcome {
  try {
    const p = Bun.spawnSync(cmd, opts);
    return { threw: false, exitCode: p.exitCode ?? -1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
  } catch (err) {
    return { threw: true, exitCode: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}
