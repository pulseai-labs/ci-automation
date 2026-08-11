/**
 * Stage 2 configuration — the hardened opencode `Config` object.
 *
 * Every knob here is load-bearing. See spec §8 and
 * `.superpowers/sdd/opencode-tool-discovery.md` for the mechanism. The two
 * security-relevant facts that shape this file:
 *
 *   1. The agent's tool allowlist (`tools`) is the authoritative gate on what
 *      the model can do — the registry always lists the built-ins (bash, edit,
 *      write, …), so denylist them explicitly and allowlist exactly the two
 *      read-only tools (built in Task 11).
 *   2. `OPENCODE_DISABLE_PROJECT_CONFIG` is a SECURITY CONTROL, not a
 *      preference: without it a PR checkout gets arbitrary code execution
 *      inside the reviewer at registry-build time (its `.opencode/tools/*.ts`
 *      are `import()`ed before any model turn). It is asserted by startServer
 *      and covered by a regression test in test/server.test.ts.
 */

/**
 * The five string-constant environment controls. All are `"1"`.
 *
 * `OPENCODE_CONFIG_DIR` is deliberately NOT here. Unlike these, it is a PATH
 * (the absolute location of `agent/.opencode`), so it is set per-instance by
 * `startServer` from its `configDir` option (amendment A10-1). Keeping it out
 * of this constant means the unit test can assert this object is exactly five
 * `"1"`s — and means a caller cannot accidentally share a stale path.
 */
export const HARDENED_ENV: Record<string, string> = {
  // Without this, `opencode` blocks forever during init on a models.dev fetch
  // with zero stdout, zero stderr and no timeout. Non-negotiable on every spawn.
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  // Closes the PR code-execution vector (project `.opencode/` walk-up) and keeps
  // the PR's AGENTS.md out of the system prompt and its opencode.json from
  // registering agents. See discovery doc.
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_SHARE: "1",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
};

/** Every built-in tool the reviewer must NOT have. Denylist is explicit so a
 *  future opencode release adding a new dangerous built-in does not silently
 *  grant it (the allowlist assertion in the test would still pass, but the
 *  model would lack it because only `read_symbol`/`grep_bounded` are true). */
const DENY_TOOLS = [
  "bash", "edit", "write", "patch", "task", "skill", "webfetch",
  "todowrite", "todoread", "list", "glob", "read", "grep", "question",
];

export interface ConfigOpts {
  model: string;
  systemPrompt: string;
  /** Max agentic iterations. Maps to the SDK's `maxSteps` agent field. */
  steps: number;
}

/**
 * Build the opencode `Config` for the `code-review` agent.
 *
 * The return is left structurally inferred (not annotated `Config`) because the
 * agent's `permission` map uses a wildcard key opencode's generated type does
 * not declare; the value is cast at the server boundary instead. The
 * authoritative capability control is the `tools` map, which is exact and is
 * asserted by the test.
 */
export function buildConfig(o: ConfigOpts) {
  const tools: Record<string, boolean> = {};
  for (const t of DENY_TOOLS) tools[t] = false;
  tools["read_symbol"] = true;
  tools["grep_bounded"] = true;

  return {
    // Empty, so AGENTS.md / CLAUDE.md from the checkout are never injected into
    // the system prompt. (Also enforced by OPENCODE_DISABLE_PROJECT_CONFIG, but
    // defence in depth: this is the inline config channel.)
    instructions: [] as string[],
    agent: {
      "code-review": {
        description: "Read-only Rust code reviewer for CI. Emits structured findings.",
        mode: "primary" as const,
        // Setting `prompt` REPLACES opencode's multi-thousand-char coding prompt
        // outright (a ternary in the binary, not a concatenation).
        prompt: o.systemPrompt,
        model: o.model,
        // SDK field is `maxSteps` ("Maximum number of agentic iterations before
        // forcing text-only response"). The brief's ConfigOpts names the input
        // `steps`; the actual opencode field is `maxSteps`, not `steps`.
        maxSteps: o.steps,
        tools,
        // Defence in depth alongside the tools map. Note: opencode's permission
        // type only declares edit/bash/webfetch/doom_loop/external_directory, so
        // a `"*"` entry is best-effort — the `tools` allowlist is the hard gate.
        permission: { "*": "deny" as const },
      },
    },
  };
}
