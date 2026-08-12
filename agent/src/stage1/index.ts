import type { EvidencePack, SymbolInfo, ContainerInfo } from "../types";
import { getDiff, getChangedFiles, cap } from "./diff";
import { detectLanguage } from "./languages";

export const CAPS = {
  diff: 150_000,
  // 24,000, not the original 8,000 (spec amendment, task-s1 fix round 1):
  // at 8,000 a single dominant container (e.g. `impl PulseDB` at 7,101 B —
  // 89% of the budget) makes the whole-container trim effectively
  // all-or-nothing on exactly the container most likely to hold the
  // peer-divergence defect this feature targets, and survival depended on
  // 897 B of incidental slack ahead of it in sort order. At 24,000 the real
  // PulseDB golden diff's full container evidence (19,594 B, all 8
  // containers) fits whole — see task-s1-report.md, "Fix round 1".
  containers: 24_000,
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

/**
 * Sort `items` by `cmp`, then greedily keep whole elements in that order
 * until the next one would push the serialized array past `limit` bytes.
 * `used` seeds at 2 for the array's `[` and `]`; each kept element after the
 * first adds 1 for the separating comma. An item that does not fit is
 * skipped (`continue`), not fatal (`break`) — a later, smaller item may
 * still fit. `capped` is true iff at least one item did not make it in,
 * which is exactly the case where serializing every item in `items` would
 * have exceeded `limit`.
 *
 * Deliberate behaviour change from the two loops this replaced (fix round
 * 1, review finding 4): those only sorted *inside* an `if (rawBytes > CAP)`
 * guard, so an under-cap section kept whatever order its source produced
 * it in. This always sorts, even when nothing gets trimmed. That source
 * order is not itself deterministic for clippy — real `cargo clippy
 * --message-format=json` interleaves diagnostics across parallel codegen
 * units — so the old under-cap path was a latent determinism hole in a
 * layer-0 guarantee ("same commit in, byte-identical pack out"). Always
 * sorting closes it. Confirmed emitting a descending-order clippy fixture
 * under the cap: `b791c03` (pre-trimToCap) reproduces the emission order
 * verbatim (`10,9,8...1`); this version always returns it sorted
 * (`1,2,3...10`) — see task-s1-report.md's "Fix round 1".
 */
function trimToCap<T>(items: T[], limit: number, cmp: (a: T, b: T) => number): { kept: T[]; capped: boolean } {
  const sorted = [...items].sort(cmp);
  const kept: T[] = [];
  let used = 2; // '[' + ']' of the serialized array
  for (const item of sorted) {
    const size = Buffer.byteLength(JSON.stringify(item), "utf8");
    const sep = kept.length === 0 ? 0 : 1; // ',' separating this element from the previous one
    if (used + size + sep > limit) continue;
    kept.push(item);
    used += size + sep;
  }
  return { kept, capped: kept.length !== sorted.length };
}

export async function gather(o: GatherOpts): Promise<EvidencePack> {
  const capped: string[] = [];
  const degraded: string[] = [];

  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: o.repo })
    .stdout.toString().trim();

  const lang = detectLanguage(o.repo);
  const filePattern = lang?.filePattern ?? "*";
  const changed = getChangedFiles(o.repo, o.base, filePattern);
  const d = getDiff(o.repo, o.base, filePattern, o.diffCap ?? CAPS.diff);
  if (d.capped) capped.push("diff");

  // `symbols` is small by construction (four short string fields each) and
  // is left uncapped. The evidence that used to make this section
  // O(symbols × container size) — each symbol's full sibling signature
  // list — now lives once per container in `containers`, which is what the
  // cap below bounds. Symbols and containers are only populated when a
  // language module is detected; otherwise the diff is still gathered (with
  // the `"*"` pattern) but symbol/linter sections are omitted.
  let symbols: SymbolInfo[] = [];
  let containers: ContainerInfo[] = [];
  if (lang) {
    const extracted = await lang.extractSymbols(o.repo, o.base, changed);
    symbols = extracted.symbols;
    const containerTrim = trimToCap(
      extracted.containers,
      CAPS.containers,
      // deterministic trim: keep whole containers in path/label order until the cap
      (a, b) => a.path.localeCompare(b.path) || a.container.localeCompare(b.container),
    );
    containers = containerTrim.kept;
    if (containerTrim.capped) capped.push("containers");
  } else {
    degraded.push("no language module detected — symbols omitted");
  }

  let clippy: EvidencePack["clippy"] = [];
  let apiDelta: string | undefined;
  let semver: EvidencePack["semver"];

  if (!o.skipCargo && lang) {
    const toolOpts = o.cargoBin ? { cargoBin: o.cargoBin } : {};
    const c = lang.runLinters(o.repo, o.base, changed, toolOpts);
    clippy = c.findings; degraded.push(...c.degraded);
    const clippyTrim = trimToCap(
      clippy,
      CAPS.clippy,
      // deterministic trim: keep whole findings in path/line/title order until
      // the cap, mirroring the container trim above (same shape, same
      // localeCompare pattern for string fields so the two adjacent trims
      // stay consistent).
      (a, b) => a.path.localeCompare(b.path) || (a.line - b.line) || a.title.localeCompare(b.title),
    );
    clippy = clippyTrim.kept;
    if (clippyTrim.capped) capped.push("clippy");
    if (lang.runApiTools) {
      const a = lang.runApiTools(o.repo, o.base, toolOpts);
      if (a.apiDelta) {
        const t = cap(a.apiDelta, CAPS.apiDelta);
        apiDelta = t.text; if (t.capped) capped.push("apiDelta");
      }
      semver = a.semver; degraded.push(...a.degraded);
    }
  } else {
    degraded.push(o.skipCargo ? "cargo sections skipped by caller" : "no language module — cargo sections omitted");
  }

  const pack: EvidencePack = {
    head, diff: d.diff, changed, symbols, containers, clippy, apiDelta, semver,
    language: lang?.name,
    budget: { bytes: 0, capped }, degraded,
  };
  pack.budget.bytes = Buffer.byteLength(JSON.stringify(pack), "utf8");
  return pack;
}
