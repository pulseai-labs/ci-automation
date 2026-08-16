import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { EvidencePack, Finding, ReviewResult, Usage } from "./types";
import { gather } from "./stage1";
import { finalize, renderReport } from "./stage3";
import { initResult, writeResult } from "./result";
import { buildConfig } from "./stage2/config";
import { startServer } from "./stage2/server";
import { reason as stage2Reason } from "./stage2/run";

export type ReasonFn = (pack: EvidencePack, repo: string)
  => Promise<{ findings: Finding[]; usage?: Usage }>;

export interface ReviewOpts {
  repo: string;
  base: string;
  outDir: string;
  skipCargo?: boolean;
  deadlineMs?: number;
  /**
   * Optional per-repo review skill identifier (e.g. "pulsedb-review"). When
   * the default reason is used this is threaded into `ConfigOpts.skillName`,
   * which adds the skill to `skills.paths`. Unused by `runReview` itself — the
   * skill is baked into the injected `reason` function — but carried on the
   * opts so a caller can record which skill a review ran under.
   */
  skill?: string;
  /** stage 2. Injectable so the pipeline is testable with no model. */
  reason: ReasonFn;
}

const DEFAULT_DEADLINE_MS = 20 * 60 * 1000;

/**
 * The real stage 2 wired as the orchestrator's default `reason`. Builds a
 * hardened opencode config from `promptFile` + `model`, starts a server, drives
 * one structured-output turn, and tears the server down. One server per review
 * (startServer is the lifecycle entry point).
 *
 * Amendment A13-1: `configDir` is threaded through to `startServer`. Task 10's
 * `startServer` REQUIRES `configDir` (the absolute path to the agent's
 * `.opencode` dir) — without it `OPENCODE_CONFIG_DIR` is undefined and the model
 * gets zero custom tools (read_symbol/grep_bounded are discovered there). It
 * defaults to this package's own `.opencode` dir, resolved against this source
 * file so it is correct regardless of the process cwd.
 */
export function defaultReason(opts: {
  model: string;
  promptFile: string;
  steps?: number;
  configDir?: string;
  skillName?: string;
}): ReasonFn {
  const configDir =
    opts.configDir ?? new URL("../.opencode", import.meta.url).pathname;
  return async (pack, repo) => {
    // Build the system prompt: general prompt + optional skill content.
    // Skills are injected directly rather than loaded via opencode's `skill`
    // tool (which is denied) because in a headless CI context the operator
    // specifies the skill — the model should not need to "decide" to load it.
    let systemPrompt = readFileSync(opts.promptFile, "utf8");
    if (opts.skillName) {
      // Validate the skill name is a single directory name — no path
      // traversal. A skill like "../../etc/evil" must never escape the
      // trusted skills root.
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(opts.skillName)) {
        throw new Error(
          `invalid skill name: ${opts.skillName}. Must be a single ` +
          `directory name (letters, digits, hyphens), no path segments.`,
        );
      }
      const skillsRoot = resolve(configDir, "skills");
      const skillDir = resolve(skillsRoot, opts.skillName);
      const skillFile = join(skillDir, "SKILL.md");
      // Double-check the resolved path is still under the trusted root.
      if (!skillDir.startsWith(skillsRoot + "/") && skillDir !== skillsRoot) {
        throw new Error(
          `skill path escapes the trusted skills directory: ${opts.skillName}`,
        );
      }
      const skillContent = readFileSync(skillFile, "utf8");
      systemPrompt += `\n\n## Project-Specific Review Skill: ${opts.skillName}\n\n${skillContent}`;
    }
    const handle = await startServer({
      configDir,
      reviewLanguage: "rust", // Phase 1: always Rust. Phase 4+ reads from detection.
      config: buildConfig({
        model: opts.model,
        systemPrompt,
        steps: opts.steps ?? 25,
        // Register the Langfuse plugin through the inline config channel —
        // the file-scan of the config dir proved unreliable inside CI jobs
        // (see ConfigOpts.pluginEntry). A file:// path spec is first-class
        // and never touches npm.
        pluginEntry: pathToFileURL(join(configDir, "plugin", "langfuse.ts")).href,
      }),
    });
    try {
      return await stage2Reason(handle, pack, repo);
    } finally {
      // Langfuse tracing: let the server go idle (session.idle fires within
      // ms of the final turn) so the observability plugin force-flushes its
      // span batch before the child is terminated. Probe evidence
      // (.superpowers/sdd/langfuse-plugin-probe.md): spans also land without
      // this settle, so it is insurance, not a correctness requirement.
      await new Promise((r) => setTimeout(r, 2_000));
      handle.close();
    }
  };
}

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

    // Short-circuit: no Rust files in the diff → INCONCLUSIVE without a model
    // turn. Saves tokens and avoids StructuredOutputError when the model gets
    // an empty evidence pack it cannot review.
    if (pack.changed.length === 0) {
      result = finalize([], pack, o.repo);
      writeResult(o.outDir, result);
      writeFileSync(join(o.outDir, "report.md"), renderReport(result, pack));
      return result;
    }

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

/**
 * CLI entrypoint. Invoked by the CI hub workflow (`droid.yml`) for the
 * `code-review` automation. Reads TARGET_DIR / OUT_DIR / BASE_REF / MODEL from
 * the environment.
 *
 * Amendment A14-1: `steps: 25` — `maxSteps: 12` is insufficient for glm-5.2 on
 * a real diff (proven in Task 13). The model exhausts the budget, opencode
 * forces text-only mode, and structured output is disabled. 25 is the minimum.
 */
if (import.meta.main) {
  const repo = process.env.TARGET_DIR ?? process.cwd();
  const out = process.env.OUT_DIR ?? ".";
  const r = await runReview({
    repo,
    base: process.env.BASE_REF ?? "origin/main",
    outDir: out,
    reason: defaultReason({
      model: process.env.MODEL ?? "zai-coding-plan/glm-5.2",
      promptFile: new URL("./prompts/code-review.md", import.meta.url).pathname,
      steps: 25,
      skillName: process.env.SKILL || undefined,
    }),
  });
  console.log(`verdict=${r.verdict} reason=${r.reason}`);
  process.exit(r.verdict === "ERROR" || r.verdict === "FAIL" ? 1 : 0);
}
