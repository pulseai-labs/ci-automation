# Langfuse tracing for the review agent — design

- **Status:** approved by the operator in session, 2026-08-17
- **Scope:** the custom review agent (`agent/`) only — `code-review` today;
  `qa`/`security-audit` inherit tracing when they migrate off droid. droid
  itself is out of scope (no plugin mechanism).
- **Does not change:** the hardening contract, the two-app split, the mint
  helper's existing subcommands, the verdict/report pipeline.

> **Provenance.** Facts are marked `[M]` measured/verified on this host or the
> mini today, `[D]` from source/docs, `[E]` estimated. The plugin-resolution
> facts come from `.superpowers/sdd/opencode-tool-discovery.md` (on the mini,
> 2026-08-10) plus binary-strings checks against opencode 1.17.8 performed for
> this design.

---

## 1. Why

Review runs are opaque: when a verdict looks wrong, the only artifact is the
final report. Langfuse traces give per-run visibility — prompt, turns, tool
calls, tokens, cost — grouped and findable per PR. Langfuse v4 is self-hosted
on the same Mac mini that hosts the runner, so ingestion is loopback and free.

## 2. Verified facts this design rests on

1. **Plugin resolution under hardening `[M]`.** The spawned opencode server
   scans `$OPENCODE_CONFIG_DIR/plugin/*.ts` **unconditionally** — the disable
   flag does not gate it (discovery doc, PLUG rows). A file-based plugin in
   `agent/.opencode/plugin/` therefore loads with the hardening untouched.
2. **The plugin's opencode surface exists in 1.17.8 `[M]`.** Binary strings
   contain `chat.message`, `tool.execute.*`, `session.idle`,
   `message.part.updated`, `server.instance.disposed`, `openTelemetry`,
   `resolvePluginSpec`. (Strings prove presence, not firing — the probe in §7
   proves firing.)
3. **Plugin credential contract `[D]` (source read).**
   `@langfuse/opencode-observability-plugin` v0.2.0 reads:
   - `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` — both required, else it
     logs `[Tracing disabled] Missing langfuse credentials` and no-ops.
   - `LANGFUSE_BASE_URL ?? LANGFUSE_BASEURL` (canonical has the underscore;
     the Langfuse docs page that says `LANGFUSE_BASEURL` is wrong).
   - `LANGFUSE_ENVIRONMENT` → Langfuse trace `environment` field.
   - `LANGFUSE_USER_ID` → `langfuse.user.id` on every span.
4. **No tags support upstream `[D]`.** Langfuse makes traces filterable only
   via the `langfuse.trace.tags` (string[]) span attribute; the plugin never
   sets it and offers no config for it. Resource attributes do NOT become
   tags (`[D]` Langfuse OTel mapping table). Meeting the "findable per PR"
   requirement therefore requires a patched copy.
5. **The plugin's exporter is self-contained `[D]`.** It builds its own
   `NodeTracerProvider` + `LangfuseSpanProcessor` (bundled) and exports
   directly to the Langfuse ingestion API. `experimental.openTelemetry` only
   silences a plugin warning if set; it is not load-bearing for export.
6. **Keys verified `[M]`, 2026-08-17.** A dedicated `ci-automation` project
   exists; its keys authenticate from the dev machine via
   `https://dracos-mac-mini-1.tail71316d.ts.net` and from the mini via
   `http://127.0.0.1:3000` (both `GET /api/public/projects` → 200). Keys live
   ONLY in the transcript and the root-owned file on the mini — never in this
   repository (public).
7. **The runner's base URL is loopback `[M]`.** CI jobs run on the mini
   itself; the helper emits `LANGFUSE_BASE_URL=http://127.0.0.1:3000`. The
   Tailscale URL is for dev machines only.

## 3. Architecture

```
hub droid.yml (Run review agent step)                 Mac mini
  ├─ sudo -n pulseai-mint-token langfuse-creds   ───► /usr/local/libexec/pulseai-mint-token
  │    prints LANGFUSE_{PUBLIC_KEY,SECRET_KEY,BASE_URL}   reads /usr/local/etc/pulseai-ci/langfuse.env
  │                                                        (root:wheel 0400)
  ├─ step env: LANGFUSE_ENVIRONMENT=<automation kind>
  │            LANGFUSE_USER_ID=praveensingh2897@gmail.com
  │            LANGFUSE_TRACE_REPO=<owner/repo>  LANGFUSE_TRACE_PR=<n>
  └─ bun run src/review.ts
       └─ startServer: copy EXACTLY the sanctioned LANGFUSE_* set onto the
          child env; strip every other LANGFUSE_*/OTEL_* variable
            └─ opencode serve (hardened, OPENCODE_CONFIG_DIR=agent/.opencode)
                 └─ plugin/langfuse.ts (entry) → vendored+patched plugin
                      └─ OTel spans → http://127.0.0.1:3000  (ci-automation project)
```

## 4. Components

### 4.1 Vendored plugin (upstream v0.2.0, commit 64a8d3d, MIT)

- Source vendored at `agent/vendor/opencode-langfuse/` (5 files, ~1,400 lines)
  with a `VENDORED.md` recording upstream commit + the local patch.
- Runtime deps added to `agent/package.json`: `@opencode-ai/plugin`,
  `@opentelemetry/api`, `@opentelemetry/sdk-trace-base`,
  `@opentelemetry/sdk-trace-node`, `effect`, `@langfuse/otel`. Resolved from
  `agent/node_modules` by Bun's directory walk-up; CI already runs
  `bun install --frozen-lockfile` there.
- **The patch** (~15 lines in `createLangfuseClient`): a
  `makeTraceTagsSpanProcessor()` mirroring the upstream
  `makeUserIdSpanProcessor`, reading `LANGFUSE_TRACE_REPO` / `LANGFUSE_TRACE_PR`
  once at client creation and stamping every span with
  `langfuse.trace.tags = [repo, "pr-N"]` (repo only when no PR is set). This
  is the only upstream behavior change; a rebase is a diff review of one
  function.
- **Entry** `agent/.opencode/plugin/langfuse.ts`: default-exports an async
  plugin that dynamic-imports the vendored plugin inside try/catch and calls
  it; on ANY failure returns `{}`. Tracing can never break a review. Absent
  creds additionally hit the upstream no-op path, which is the second
  degrade layer.

Rejected alternative: the officially documented `plugin:
["@langfuse/opencode-observability-plugin"]` config entry resolves and
installs from npm **at every server spawn** — network-dependent init on the
mini's weak Wi-Fi, the same failure class that made
`OPENCODE_DISABLE_MODELS_FETCH` mandatory. Vendoring also carries the tags
patch, which the config entry cannot.

### 4.2 Env threading (`agent/src/stage2/config.ts` + `server.ts`)

- New exported `TRACING_ENV_KEYS`: exactly the seven sanctioned names —
  `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`,
  `LANGFUSE_ENVIRONMENT`, `LANGFUSE_USER_ID`, `LANGFUSE_TRACE_REPO`,
  `LANGFUSE_TRACE_PR`.
- New pure function `applyTracingEnv(env)` (unit-testable without a server):
  for each sanctioned key present, keep it; **delete every other key starting
  `LANGFUSE_` or `OTEL_`**. "Pass exactly those through — nothing else"
  becomes a tested invariant, not a comment. (`OTEL_*` is stripped because
  the plugin's bundled OTel stack reads standard `OTEL_*` knobs; a stray one
  in the job env must not silently reconfigure or redirect export.)
- `startServer` calls it on `process.env` before `createOpencodeServer`, next
  to the existing `HARDENED_ENV` loop. `HARDENED_ENV` itself is untouched —
  still exactly five `"1"`s, its exactness test unchanged.
- `buildConfig` gains `experimental: { openTelemetry: true }` per the plugin
  docs (cosmetic on 1.17.8 — silences the plugin's warning; the probe
  confirms the key survives config parsing).

### 4.3 Credentials on the runner (mint-helper pattern)

- Root-owned `/usr/local/etc/pulseai-ci/langfuse.env`
  (`root:wheel 0400`): the three `KEY=VALUE` lines, with
  `LANGFUSE_BASE_URL=http://127.0.0.1:3000` (loopback — the runner IS the
  mini).
- New helper subcommand `langfuse-creds` (hardcoded output, no arguments,
  same design rule as the other subcommands: it cannot be widened by a
  caller). The existing sudoers rule already covers the whole helper binary
  for `github-runner`, so no sudoers change.
- Workflow step sources it once, best-effort:
  `set -a; . <(sudo -n /usr/local/libexec/pulseai-mint-token langfuse-creds 2>/dev/null) || true; set +a`
  — same trust model as the existing `TOK="$(sudo …)"` captures: the helper
  is root-owned and its output is root-produced.
- Install/self-test ships as `scripts/install-langfuse-keys.sh` in
  `draco-hub-macos-server` (follows `install-mint-helper.sh`: refuses bad
  perms, verifies as `github-runner`, revokes nothing — the keys are static).
- Hosted-runner code-review runs get no tracing (creds exist only on the
  mini) — that is the degrade path, by design.

### 4.4 Trace labels

| Label | Source |
| --- | --- |
| environment | `LANGFUSE_ENVIRONMENT` = `${{ matrix.automation }}` (qa / code-review / security-audit) |
| userId | `LANGFUSE_USER_ID` = `praveensingh2897@gmail.com` (a label, not a secret; appears in the public workflow file — operator approved) |
| tags | `[target repo, "pr-<n>"]` via the patch; repo falls back to the calling repo when `target-repo` is empty |
| session | opencode sessionID (upstream behavior) — one session per review |

`LANGFUSE_TRACE_REPO`/`LANGFUSE_TRACE_PR` are set in the step `env:` from
`needs.validate.outputs` (already validated upstream: owner/repo charset,
numeric PR) — never interpolated into `run:` blocks, per house rules.

## 5. Degrade layers (each tested)

1. Workflow: helper missing/non-zero → sourcing is best-effort, step
   continues exactly as today.
2. Loader: vendored import throws (deps absent, FS damage) → entry returns
   `{}`, review proceeds untraced.
3. Upstream: creds absent → plugin logs a warning, returns `{}`.

No layer can fail a review, and none can half-configure: the same absence
that disables the plugin disables export.

## 6. Security considerations

- Keys never appear in this repository, in workflow files, or in logs (the
  helper prints them to a sourced stream; GitHub masks nothing because
  nothing is a secret here — the values never enter Actions' secret store).
- The vendored plugin runs inside the opencode server process — same trust
  domain as the agent's own tools. It registers **no model-facing tools**
  and cannot expand the model's capabilities; its only I/O is reading the
  sanctioned env vars and POSTing spans to the loopback Langfuse.
- Traced content includes untrusted PR text (diffs, messages) — that is the
  point of tracing; the destination is our own Langfuse project.
- The strip rule prevents any non-sanctioned `OTEL_*`/`LANGFUSE_*` variable
  in the job environment from redirecting or reconfiguring export.

## 7. Testing (house TDD conventions)

- **Unit (run locally, always green):** `TRACING_ENV_KEYS` exactness;
  `applyTracingEnv` keeps the seven / strips unsanctioned `LANGFUSE_*` +
  `OTEL_*`; tags processor stamps `langfuse.trace.tags` (fake span);
  entry returns `{}` with no creds (upstream degrade path exercised in-process);
  `buildConfig` gains exactly `experimental.openTelemetry` and nothing else.
- **Integration (mini; gated on `Bun.which("opencode")` AND server version
  `1.17.` so they SKIP on the dev MacBook instead of failing):** hardened
  spawn with the real `agent/.opencode` config dir and fake creds → server
  boots, liveness probe 200, the existing security canaries still hold
  (exact tool set; PR-dir code not executed). Plugin-load proof is §7-probe
  + §9 e2e, not an assertion on internal logs.
- **Probe (mini, scratch dirs, recorded as
  `.superpowers/sdd/langfuse-plugin-probe.md`):** SDK spawn with the vendored
  plugin + REAL keys → one real model turn → assert the trace arrives in the
  `ci-automation` project via the public API, with environment/userId/tags.
  This is the gate that proves the 1.17.8 event surface actually fires and
  that spans flush before `server.close()`. If flush is lossy, mitigation is
  a bounded post-turn settle delay in `defaultReason` before close.
- **E2E acceptance:** a real PR run through the hub workflow on the mini →
  trace visible in Langfuse with all four labels. This is the acceptance
  criterion from the brief.

## 8. Deployment sequence

1. Branch → PR → merge (code; nothing installed by hand).
2. On the mini (operator or agent over SSH with sudo): run
   `scripts/install-langfuse-keys.sh` from `draco-hub-macos-server` — writes
   the root-owned env file and extends the helper. Idempotent.
3. Consumer twin bumps its `uses:` SHA to the merged commit (the hub pin).
4. AGENTS.md documents the feature: env contract, labels, degrade behavior,
   the `LANGFUSE_BASE_URL` spelling trap, and the dev-machine notes (local
   opencode is 1.18.13 → integration tests skip locally by design).

## 9. Traps recorded up front

| Trap | Handling |
| --- | --- |
| `LANGFUSE_BASEURL` (docs) vs `LANGFUSE_BASE_URL` (source) | We set the canonical underscore name; the plugin accepts both |
| Spans lost if the child dies before flush | Probe measures; settle-delay mitigation if needed |
| `waitForDependencies` bun-install at spawn (network) | Probe watches the config dir for spawned installs; vendoring avoids npm-spec resolution entirely |
| Local opencode 1.18.13 ≠ pinned 1.17.8 | Integration tests version-gate and skip locally |
| Keys in transcript | Accepted by operator; keys rotate freely in the Langfuse UI if ever needed |
