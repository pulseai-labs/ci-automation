import type { EvidencePack } from "../types";
import { getDiff, getChangedFiles, cap } from "./diff";
import { extractSymbols } from "./symbols";
import { runClippy } from "./lint";
import { runApiDelta, runSemverChecks } from "./cargoTools";

export const CAPS = {
  diff: 150_000,
  siblings: 8_000,
  clippy: 16_000,
  apiDelta: 8_000,
};

export interface GatherOpts {
  repo: string;
  base: string;
  diffCap?: number;
  /** skip cargo-dependent sections; used by fast tests */
  skipCargo?: boolean;
  /** override the cargo binary passed to clippy/api-delta/semver-checks; for hermetic tests */
  cargoBin?: string;
}

/**
 * Stage 1 orchestrator: pure evidence gathering, no model calls. Calls the
 * stage1/ primitives in order, enforces the byte caps in `CAPS`, and records
 * what it truncated (`budget.capped`) and what it degraded (`degraded`).
 *
 * Async because `extractSymbols` (tree-sitter WASM init) is async — plan
 * amendment A1. `git rev-parse HEAD` is run with the plain, unguarded
 * `Bun.spawnSync` here (matching the plan text and `diff.ts`'s own `git`
 * helper), not `spawnGuarded`: a spawn-level throw here means git itself
 * could not be started in `repo`, which is a fatal precondition for every
 * other section this function calls (they all shell out to the same repo)
 * — there is no partial evidence pack worth degrading to. Letting it throw
 * surfaces that immediately instead of silently producing a pack with an
 * empty `head`.
 */
export async function gather(o: GatherOpts): Promise<EvidencePack> {
  const capped: string[] = [];
  const degraded: string[] = [];

  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: o.repo })
    .stdout.toString().trim();

  const changed = getChangedFiles(o.repo, o.base);
  const d = getDiff(o.repo, o.base, o.diffCap ?? CAPS.diff);
  if (d.capped) capped.push("diff");

  let symbols = await extractSymbols(o.repo, o.base, changed);
  const sibBytes = Buffer.byteLength(JSON.stringify(symbols), "utf8");
  if (sibBytes > CAPS.siblings) {
    // deterministic trim: keep whole symbols in file/name order until the cap
    symbols = [...symbols].sort((a, b) =>
      a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
    const kept: typeof symbols = [];
    let used = 0;
    for (const s of symbols) {
      const size = Buffer.byteLength(JSON.stringify(s), "utf8");
      if (used + size > CAPS.siblings) break;
      kept.push(s); used += size;
    }
    symbols = kept;
    capped.push("symbols");
  }

  let clippy: EvidencePack["clippy"] = [];
  let apiDelta: string | undefined;
  let semver: EvidencePack["semver"];

  if (!o.skipCargo) {
    const toolOpts = o.cargoBin ? { cargoBin: o.cargoBin } : {};
    const c = runClippy(o.repo, o.base, changed, toolOpts);
    clippy = c.findings; degraded.push(...c.degraded);
    const clippyBytes = Buffer.byteLength(JSON.stringify(clippy), "utf8");
    if (clippyBytes > CAPS.clippy) {
      // deterministic trim: keep whole findings in path/line/title order until the
      // cap, mirroring the symbol trim above (same shape, same localeCompare
      // pattern for string fields so the two adjacent trims stay consistent).
      clippy = [...clippy].sort((a, b) =>
        a.path.localeCompare(b.path) || (a.line - b.line) || a.title.localeCompare(b.title));
      const kept: typeof clippy = [];
      let used = 0;
      for (const f of clippy) {
        const size = Buffer.byteLength(JSON.stringify(f), "utf8");
        if (used + size > CAPS.clippy) break;
        kept.push(f); used += size;
      }
      clippy = kept;
      capped.push("clippy");
    }
    const a = runApiDelta(o.repo, o.base, toolOpts);
    if (a.apiDelta) {
      const t = cap(a.apiDelta, CAPS.apiDelta);
      apiDelta = t.text; if (t.capped) capped.push("apiDelta");
    }
    degraded.push(...a.degraded);
    const s = runSemverChecks(o.repo, toolOpts);
    semver = s.semver; degraded.push(...s.degraded);
  } else {
    degraded.push("cargo sections skipped by caller");
  }

  const pack: EvidencePack = {
    head, diff: d.diff, changed, symbols, clippy, apiDelta, semver,
    budget: { bytes: 0, capped }, degraded,
  };
  pack.budget.bytes = Buffer.byteLength(JSON.stringify(pack), "utf8");
  return pack;
}
