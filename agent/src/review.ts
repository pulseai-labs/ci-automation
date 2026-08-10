import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvidencePack, Finding, ReviewResult, Usage } from "./types";
import { gather } from "./stage1";
import { finalize, renderReport } from "./stage3";
import { initResult, writeResult } from "./result";

export type ReasonFn = (pack: EvidencePack, repo: string)
  => Promise<{ findings: Finding[]; usage?: Usage }>;

export interface ReviewOpts {
  repo: string;
  base: string;
  outDir: string;
  skipCargo?: boolean;
  deadlineMs?: number;
  /** stage 2. Injectable so the pipeline is testable with no model. */
  reason: ReasonFn;
}

const DEFAULT_DEADLINE_MS = 20 * 60 * 1000;

/** A minimal synthetic pack to render against when `gather()` itself threw
 *  and no real `EvidencePack` was ever produced — see amendment A3. Renders
 *  an ERROR verdict's `reason` into a real report.md rather than leaving
 *  the failure recorded only in result.json. */
function shellPack(): EvidencePack {
  return {
    head: "", diff: "", changed: [], symbols: [], containers: [], clippy: [],
    budget: { bytes: 0, capped: [] }, degraded: [],
  };
}

/**
 * The orchestrator: gather -> stage 2 (injected) -> finalize -> render.
 * Never imports stage 2 itself — `reason` is passed in, which is what makes
 * this milestone possible with no model anywhere (see task-9-brief.md).
 *
 * Fail-closed contract: `initResult()` seeds a terminal ERROR result.json
 * before any other work, so a crash, a kill, or a hung provider still
 * leaves a readable terminal state on disk. `writeResult()` below then
 * overwrites it with the real outcome only once the run has actually
 * completed (successfully or by falling into the catch block).
 */
export async function runReview(o: ReviewOpts): Promise<ReviewResult> {
  // Fix round 1, Fix 3: the function that owns the fail-closed contract must
  // not depend on an unwritten caller having created outDir first — without
  // this, a nonexistent outDir makes initResult() itself throw ENOENT and no
  // terminal state is written anywhere, a hole at line one of the guarantee.
  mkdirSync(o.outDir, { recursive: true });
  initResult(o.outDir);

  let pack: EvidencePack | undefined;
  let result: ReviewResult;

  try {
    // Amendment A1: gather() is async (tree-sitter WASM init).
    pack = await gather({ repo: o.repo, base: o.base, skipCargo: o.skipCargo });

    const deadlineMs = o.deadlineMs ?? DEFAULT_DEADLINE_MS;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, rej) => {
      timer = setTimeout(
        () => rej(new Error(`self-deadline exceeded after ${deadlineMs}ms`)),
        deadlineMs,
      );
    });

    let stage2: { findings: Finding[]; usage?: Usage };
    try {
      stage2 = await Promise.race([o.reason(pack, o.repo), deadline]);
    } finally {
      // Amendment A2: clear on both the success and failure paths, or a
      // pending timer keeps the event loop alive until the deadline elapses
      // even after a successful review.
      clearTimeout(timer!);
    }

    result = finalize(stage2.findings, pack, o.repo);
    result.usage = stage2.usage;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = {
      verdict: "ERROR",
      reason: msg,
      findings: [],
      degraded: pack?.degraded ?? [],
      capped: pack?.budget.capped ?? [],
    };
  }

  writeResult(o.outDir, result);
  // Amendment A3: always write report.md, even when `pack` never got
  // assigned — otherwise a human sees a red status with no explanation.
  writeFileSync(join(o.outDir, "report.md"), renderReport(result, pack ?? shellPack()));

  return result;
}
