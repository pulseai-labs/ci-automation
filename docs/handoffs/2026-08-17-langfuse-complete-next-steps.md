# Session handoff — 2026-08-17 (Langfuse complete; next: multi-language + skill-repo review)

For the next session. Written to be self-contained on the MacBook checkout
of this repo.

## 1. Where things stand (COMPLETE — do not redo)

Langfuse tracing for the code-review agent is finished, accepted, and live
in production across all consumers.

- Feature merged on `main` (HEAD at time of writing: `8349439`); vendored
  plugin + 4 local patches at `agent/vendor/opencode-langfuse/` (see its
  `VENDORED.md` for every patch and the rebase procedure).
- All three consumers bumped and merged at `92e5f8b`:
  `pulsedb-internal` PR #15, `claude-agent-scaffolding-internal` PR #1,
  `pulse-trader-internal` PR #1. Discovery is live via
  `scripts/bump-consumer-pins.sh` in `draco-hub-macos-server`
  (`--merge` to auto-merge) — run it after every merge here.
- Credentials: root-owned `/usr/local/etc/pulseai-ci/langfuse.env` on the
  mini; jobs fetch via `pulseai-mint-token langfuse-creds`. Keys never in
  this repo (public). Rotating = Langfuse UI + re-run
  `scripts/install-langfuse-keys.sh` (hub repo).
- Model pricing: fixed by patch #4 (drops the plugin's explicit zero-cost
  override, adds `gen_ai.*` model/usage attributes). Custom model
  definitions in the `ci-automation` Langfuse project must be named
  exactly `glm-5.2` / `glm-5.3` (bare model id). Pricing applies to NEW
  runs only. Operator was asked to eyeball the UI on session
  `ses_ff0dd13c0ffe` (2026-08-17 ~09:53 UTC) — confirm this happened.
- Tests: 203/203 on the mini; local suite has 4 known version-skew
  integration failures (MacBook opencode is 1.18.x, pin is 1.17.8) —
  integration tests version-gate and the real suite runs on the mini.
- Acceptance evidence + full debug history (including the
  `job_workflow_sha` trap and the sudo-in-`<( )` trap):
  `.superpowers/sdd/langfuse-plugin-probe.md` **on the mini only**
  (gitignored scratch — see task 3 below).

## 2. Next session's work — the operator's chosen scope

Decision made by the operator 2026-08-17 (this OVERRIDES the earlier
recommendation of security-audit-first): **complete code-review language
and repo-type coverage first**, then security-audit, then QA migration.

### 2a. Multi-language review: Python and TypeScript

Current state (verified):
- `agent/src/stage1/languages/` is a registry designed for this:
  `MODULES: LanguageModule[] = [rust]` with
  `detectLanguage(repo)` / `getLanguage(name)`. The file literally says
  "Phase 1: only Rust. Phase 2+ adds more modules here."
- `LanguageModule` interface (`types.ts`): `name`, `detect(repo)` (rust =
  Cargo.toml exists), `filePattern`, `extractSymbols` (tree-sitter,
  `web-tree-sitter` + wasm grammar), `runLinters` (rust = clippy,
  changed-lines only), optional `runApiTools` (cargo public-api — not
  installed), `readSymbolPattern` (the regex `read_symbol` uses).
- Rust-only choke points to lift:
  - `agent/src/review.ts` `defaultReason` hardcodes
    `reviewLanguage: "rust"` (Phase 4+ note says read from detection).
  - `runReview` short-circuits INCONCLUSIVE when `pack.changed.length === 0`
    (gather filters to Rust files only today).
  - `read_symbol` impl has a "rust" fallback for its symbol pattern.
  - `agent/src/prompts/code-review.md` is Rust-flavored prose.
  - `FINDINGS_SCHEMA` categories are language-agnostic already.
- Design questions to settle (operator wants discussion first):
  - Linters on the runner for deterministic findings: ruff (python),
    eslint/tsc (typescript)? Which are installed on the mini? Degrade
    gracefully when absent (existing `degraded[]` pattern).
  - Symbol extraction: `tree-sitter-python` / `tree-sitter-typescript` wasm
    grammars (bun-compatible, same as `tree-sitter-rust` today).
  - Mixed-language repos/diffs: per-file module routing vs primary-language
    detection; what the evidence pack looks like when two languages change.
  - Prompt strategy: per-language prompts vs one neutral prompt + language
    section.

### 2b. Skill/prose repos (prime example: claude-agent-scaffolding)

The operator's priority case. `claude-agent-scaffolding` (public) is ~90%
prose — a marketplace of agent skills (SKILL.md files with frontmatter,
descriptions, instructions) plus bash/python maintenance scripts. Its twin
`claude-agent-scaffolding-internal` ALREADY runs
`automations: code-review` against it (verified in its droid.yml) — so
today it gets a Rust-only review that yields nothing useful for prose
diffs.

What the operator wants such reviews to check:
- every skill in the diff: does it function as described, any defects;
- is the skill description proper (quality/clarity/consistency);
- audit-style checks that need NO language toolchain.

Design questions to settle (explicitly open for discussion next session):
- A new `LanguageModule` for "skills/prose" (detect = `.claude-plugin/` or
  SKILL.md layout) vs a separate review mode? The module's
  `extractSymbols`/`runLinters` shape maps awkwardly to prose — maybe its
  evidence pack is: changed SKILL.md contents (byte-capped), frontmatter,
  and changed support scripts.
- Which tools does the model need? `read_symbol` is symbol-regex based
  (rust pattern); prose review likely needs a capped whole-file read of
  SKILL.md-sized files and script-aware reading for bash/python. Consider a
  `read_capped` tool (byte-capped file read, deny-list binary/huge files)
  — must preserve the read-only, capped tool philosophy.
- Deterministic checks (the clippy analogue): frontmatter schema lint,
  `bash -n` syntax check on changed scripts, `python -m py_compile`,
  link/reference validation between skills.
- Prompt: a skills-review prompt (what a good SKILL.md looks like,
  description quality bar, script defect classes).
- Verdict categories: reuse the existing Finding categories or add
  prose-specific ones (schema change is load-bearing — see FINDINGS_SCHEMA
  comment about severity gating).

### 2c. Docs consolidation — make this repo self-contained

The operator's second ask: the specs/plans that ci-automation was BUILT
from live in `draco-hub-macos-server` (private) and as gitignored scratch
on the mini; the MacBook checkout of ci-automation has only
`docs/superpowers/{specs,plans}` from the Langfuse work. Bring the history
here so any session can reference what exists and what's next. Concretely:

- Copy from `draco-hub-macos-server/docs/`: the custom-agent design spec +
  plan (`docs/superpowers/{specs,plans}/2026-08-05-custom-ci-review-agent*`),
  ADR-0001 (CI automation architecture), relevant handoffs, and the
  bootstrap/runbook docs that describe the Mac mini setup.
- Copy from the MINI (gitignored there):
  `/Users/draco/projects/ci-automation/.superpowers/sdd/opencode-tool-discovery.md`
  and `langfuse-plugin-probe.md` — the two empirical foundation documents.
  (`ssh mini`; they are at that path; not in any git remote.)
- Also document the MacBook→mini operational model in this repo (AGENTS.md
  or a dedicated doc): dev here, deploy = merge + consumer pin bump; ssh
  alias `mini` (passwordless sudo); bun/opencode paths per user
  (`~/.bun/bin` for draco, `/usr/local/bin/bun` for github-runner,
  `/opt/homebrew/bin/opencode`); git-bundle-over-scp when GitHub is
  unreachable; integration tests run on the mini.
- Note: CLAUDE.md and memory-bank scaffolding deliberately DO NOT exist in
  either repo yet — operator deferred that work.

## 3. Key operational facts (the short list)

- Dev on the MacBook; the opencode server pin is 1.17.8 (mini) vs 1.18.x
  (MacBook) → integration tests skip/fail locally by design; run them on
  the mini over SSH.
- `ssh mini` = draco@dracos-mac-mini-1.tail71316d.ts.net with passwordless
  sudo. Langfuse: `http://127.0.0.1:3000` on the mini, Tailscale URL from
  the MacBook. GitHub Actions runner = user `github-runner`.
- After ANY merge to ci-automation main: run
  `scripts/bump-consumer-pins.sh` (hub repo) to propagate. Test only at
  merged-main SHAs (job_workflow_sha trap — AGENTS.md trap table).
- House TDD: bun test; unit tests always green locally; integration tests
  gated on `Bun.which("opencode")` + version prefix.
- Memory (agent-side, not repo): this workspace's memory files carry the
  status and environment facts; this handoff is the repo-side record.

## 4. Suggested first moves next session

1. Read this file + AGENTS.md (Langfuse section + traps).
2. Start a brainstorming/spec cycle for 2a+2b together (they share the
   language-registry and evidence-pack design surface; one spec covering
   "review coverage: python, typescript, skills/prose" is likely right,
   sequenced implementation).
3. Do 2c (mechanical, no design) either first as a warm-up or whenever
   context is cheap — it also feeds the spec-writing with the original
   design doc.
