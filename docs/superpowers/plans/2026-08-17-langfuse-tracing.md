# Langfuse Tracing for the Review Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every CI review run of the custom agent traces to the `ci-automation` Langfuse project on the mini, labeled by automation kind, userId, and repo/PR tags, degrading silently to today's behavior when Langfuse is absent.

**Architecture:** File-based plugin loaded from `agent/.opencode/plugin/langfuse.ts` (always scanned via `$OPENCODE_CONFIG_DIR`), wrapping a vendored copy of `@langfuse/opencode-observability-plugin` v0.2.0 patched to stamp `langfuse.trace.tags`. Credentials come from a root-owned file via a new `langfuse-creds` mint-helper subcommand, threaded through the workflow step env; `startServer` enforces an exact allowlist of seven `LANGFUSE_*` variables on the spawned server.

**Tech Stack:** Bun 1.3.6, TypeScript, `@opencode-ai/sdk` 1.17.8 (server opencode 1.17.8 on the mini), GitHub Actions reusable workflow, POSIX sh for the root helper.

**Spec:** `docs/superpowers/specs/2026-08-17-langfuse-tracing-design.md`

## Global Constraints

- The repository is PUBLIC: the Langfuse keys appear in NO committed file in `pulseai-labs/ci-automation`. They live only in the conversation transcript and the root-owned file on the mini.
- SDK pinned `@opencode-ai/sdk@1.17.8`; the opencode server binary is 1.17.8 on the mini. The dev MacBook has 1.18.13 → integration tests MUST be version-gated so they skip (not fail) locally.
- `HARDENED_ENV` stays exactly five `"1"` keys — untouched, its existing test unchanged.
- Never interpolate `inputs.*` / `github.event.*` into `run:` blocks — always `env:`.
- Unit tests (`bun test` unit portion) must pass on the MacBook. Integration tests run on the mini over SSH (`ssh mini`).
- Upstream plugin source clone lives at `/tmp/opencode-lf-plugin` (commit `64a8d3d`, v0.2.0). If missing, re-clone: `git clone --depth 1 https://github.com/langfuse/opencode-observability-plugin.git /tmp/opencode-lf-plugin`.
- Work branch: `langfuse-tracing` (already created). Commit after every green test cycle.
- SSH to the mini: `ssh mini` (alias for draco@dracos-mac-mini-1.tail71316d.ts.net, passwordless sudo available).

---

### Task 1: Vendor the plugin source + loader entry

**Files:**
- Create: `agent/vendor/opencode-langfuse/VENDORED.md`
- Create: `agent/vendor/opencode-langfuse/src/index.ts`, `src/langfuse.ts`, `src/opencode.ts`, `src/utils.ts`, `src/version.ts`
- Create: `agent/.opencode/plugin/langfuse.ts`
- Modify: `agent/package.json`, `agent/bun.lock`
- Test: `agent/test/tracing.test.ts`

**Interfaces:**
- Consumes: upstream source at `/tmp/opencode-lf-plugin/src/` (5 files).
- Produces: default-exported async plugin at `agent/.opencode/plugin/langfuse.ts` with signature `(input: { client: any; [k: string]: any }) => Promise<Hooks | {}>`; vendored module namespace with `.default` / `.LangfusePlugin`.

- [ ] **Step 1: Write the failing test (loader degrades to no-op without creds)**

Create `agent/test/tracing.test.ts`:

```ts
import { test, expect } from "bun:test";

/** Snapshot/restore every LANGFUSE_* var so tests are hermetic on machines
 *  where the operator exports them (the mini after install). */
export function snapshotLangfuseEnv() {
  const snap: Record<string, string | undefined> = {};
  for (const k of Object.keys(process.env)) if (k.startsWith("LANGFUSE_")) snap[k] = process.env[k];
  return snap;
}
export function clearLangfuseEnv() {
  for (const k of Object.keys(process.env)) if (k.startsWith("LANGFUSE_")) delete (process.env as any)[k];
}
export function restoreLangfuseEnv(snap: Record<string, string | undefined>) {
  clearLangfuseEnv();
  Object.assign(process.env, snap);
}

test("plugin entry degrades to a no-op hooks object when Langfuse creds are absent", async () => {
  const snap = snapshotLangfuseEnv();
  clearLangfuseEnv();
  try {
    const entry = (await import("../.opencode/plugin/langfuse.ts")).default;
    const hooks = await entry({ client: { app: { log: async () => {} }, tool: {} } });
    // Upstream returns exactly {} on MissingLangfuseCredentials; our loader
    // catch returns {} on import failure. Either way: an object, never a throw.
    expect(typeof hooks).toBe("object");
  } finally {
    restoreLangfuseEnv(snap);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd agent && bun test test/tracing.test.ts`
Expected: FAIL — cannot resolve module `../.opencode/plugin/langfuse.ts`.

- [ ] **Step 3: Vendor the source and write the entry**

```bash
cd agent
mkdir -p vendor/opencode-langfuse/src
cp /tmp/opencode-lf-plugin/src/index.ts /tmp/opencode-lf-plugin/src/langfuse.ts \
   /tmp/opencode-lf-plugin/src/opencode.ts /tmp/opencode-lf-plugin/src/utils.ts \
   vendor/opencode-langfuse/src/
```

Then OVERWRITE `vendor/opencode-langfuse/src/version.ts` with (upstream uses a tsdown build-time define that does not exist when Bun runs the source — see VENDORED.md):

```ts
export const PLUGIN_VERSION = "0.2.0+vendored";
```

Create `vendor/opencode-langfuse/VENDORED.md`:

```markdown
# Vendored: @langfuse/opencode-observability-plugin

- Upstream: https://github.com/langfuse/opencode-observability-plugin
- Version: 0.2.0 (commit 64a8d3d), MIT license.
- Vendored because (a) the npm-spec `plugin:` config entry resolves and
  installs from npm at every server spawn — network-dependent init on the
  runner, the failure class that made OPENCODE_DISABLE_MODELS_FETCH
  mandatory — and (b) we patch in trace tags (below), which upstream v0.2.0
  does not support.

## Local patches (keep this list complete on every rebase)

1. `src/version.ts` — replaced the tsdown build-time `__PLUGIN_VERSION__`
   define with a literal; the define does not exist when Bun runs source.
2. `src/langfuse.ts` — added `makeTraceTagsSpanProcessor` and
   `traceTagsFromEnv` (Langfuse traces are only filterable via the
   `langfuse.trace.tags` span attribute, which upstream never sets).
3. `src/index.ts` — computes `traceTags` from `LANGFUSE_TRACE_REPO` /
   `LANGFUSE_TRACE_PR` and passes them into `createLangfuseClient`.

## Rebase procedure

Diff `src/` here against the new upstream tag; the three patches above are
the only local deltas. Re-apply them by hand; never bundle the dist.
```

Add dependencies to `agent/package.json` `dependencies` (versions from upstream's package.json; `@langfuse/otel`, `effect`, `sdk-trace-*` are devDeps upstream but are imported by the source, so they are our runtime deps):

```json
    "@langfuse/otel": "^5.4.1",
    "@opencode-ai/plugin": "^1.15.13",
    "@opentelemetry/api": "^1.9.1",
    "@opentelemetry/sdk-trace-base": "^2.7.1",
    "@opentelemetry/sdk-trace-node": "^2.7.1",
    "effect": "^3.21.2",
```

Create `agent/.opencode/plugin/langfuse.ts`:

```ts
/**
 * Langfuse observability plugin entry — the only file opencode loads by
 * path. `$OPENCODE_CONFIG_DIR/plugin/*.ts` is scanned unconditionally
 * (tool-discovery doc), so this loads under the hardening contract with no
 * changes to it. Dynamic import + catch: tracing can NEVER break a review —
 * absent dependencies, damaged files, or absent credentials all degrade to
 * a no-op plugin (upstream independently no-ops without credentials).
 */
type PluginInput = { client: any; [key: string]: any };

export default async function langfusePlugin(input: PluginInput) {
  try {
    const mod: any = await import("../../vendor/opencode-langfuse/src/index.js");
    const plugin = mod.default ?? mod.LangfusePlugin;
    return await plugin(input);
  } catch {
    return {};
  }
}
```

Then: `cd agent && bun install` (updates `bun.lock` — CI uses `--frozen-lockfile`, so the lock must be committed).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd agent && bun test test/tracing.test.ts`
Expected: PASS (1 test). If it fails with a module-resolution error on the vendored `.js`-suffixed imports (Bun mapping `.js` → `.ts`), strip the `.js` extensions inside `vendor/opencode-langfuse/src/*.ts` import specifiers (`sed -i '' 's/\.js"/"/g' vendor/opencode-langfuse/src/*.ts`) and re-run.

- [ ] **Step 5: Run the whole unit suite locally**

Run: `cd agent && bun test`
Expected: 184+ pass as before; the 4 pre-existing opencode-integration failures on the MacBook are unchanged and unrelated.

- [ ] **Step 6: Commit**

```bash
git add agent/vendor agent/.opencode/plugin/langfuse.ts agent/package.json agent/bun.lock agent/test/tracing.test.ts
git commit -m "feat: vendor the Langfuse opencode plugin with a degrade-safe loader"
```

---

### Task 2: Tags patch on the vendored plugin

**Files:**
- Modify: `agent/vendor/opencode-langfuse/src/langfuse.ts`, `agent/vendor/opencode-langfuse/src/index.ts`
- Test: `agent/test/tracing.test.ts`

**Interfaces:**
- Produces: `traceTagsFromEnv(env: Record<string, string|undefined>): string[]` and `makeTraceTagsSpanProcessor(tags: string[]): SpanProcessor` exported from `agent/vendor/opencode-langfuse/src/langfuse.ts`; `createLangfuseClient` input gains optional `traceTags?: string[]`.

- [ ] **Step 1: Write the failing tests**

Append to `agent/test/tracing.test.ts`:

```ts
test("traceTagsFromEnv builds [repo, pr-N] in order, skipping what is absent", async () => {
  const { traceTagsFromEnv } = await import("../vendor/opencode-langfuse/src/langfuse.ts");
  expect(traceTagsFromEnv({ LANGFUSE_TRACE_REPO: "pulseai-labs/PulseDB", LANGFUSE_TRACE_PR: "66" }))
    .toEqual(["pulseai-labs/PulseDB", "pr-66"]);
  expect(traceTagsFromEnv({ LANGFUSE_TRACE_REPO: "pulseai-labs/PulseDB" }))
    .toEqual(["pulseai-labs/PulseDB"]);
  expect(traceTagsFromEnv({ LANGFUSE_TRACE_PR: "66" })).toEqual(["pr-66"]);
  expect(traceTagsFromEnv({})).toEqual([]);
  // An empty-string PR (workflow passes '' when there is no comment target)
  // must count as absent, not as "pr-".
  expect(traceTagsFromEnv({ LANGFUSE_TRACE_REPO: "r", LANGFUSE_TRACE_PR: "" }))
    .toEqual(["r"]);
});

test("makeTraceTagsSpanProcessor stamps langfuse.trace.tags on every span start", async () => {
  const { makeTraceTagsSpanProcessor } = await import("../vendor/opencode-langfuse/src/langfuse.ts");
  const calls: Array<[string, unknown]> = [];
  const fakeSpan = { setAttribute: (k: string, v: unknown) => void calls.push([k, v]) };
  const p = makeTraceTagsSpanProcessor(["pulseai-labs/PulseDB", "pr-66"]);
  p.onStart(fakeSpan as any, undefined as any);
  expect(calls).toEqual([["langfuse.trace.tags", ["pulseai-labs/PulseDB", "pr-66"]]]);
  // shutdown/forceFlush resolve — the plugin's dispose path awaits them.
  await p.shutdown();
  await p.forceFlush();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && bun test test/tracing.test.ts`
Expected: FAIL — no exported `traceTagsFromEnv`.

- [ ] **Step 3: Apply the patch**

In `agent/vendor/opencode-langfuse/src/langfuse.ts`, add after `makePluginVersionSpanProcessor`:

```ts
// VENDORED PATCH (see VENDORED.md #2): Langfuse makes traces filterable
// only via the `langfuse.trace.tags` (string[]) span attribute; upstream
// never sets it. Tags come from LANGFUSE_TRACE_REPO / LANGFUSE_TRACE_PR,
// set by the CI workflow per run.
export const traceTagsFromEnv = (
  env: Record<string, string | undefined>,
): string[] =>
  [
    env.LANGFUSE_TRACE_REPO,
    env.LANGFUSE_TRACE_PR ? `pr-${env.LANGFUSE_TRACE_PR}` : undefined,
  ].filter((t): t is string => Boolean(t));

export const makeTraceTagsSpanProcessor = (tags: string[]) =>
  ({
    onStart: (span: Span, _parentContext: unknown) => {
      span.setAttribute("langfuse.trace.tags", tags);
    },
    onEnd: (_span: ReadableSpan) => {},
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  }) satisfies SpanProcessor;
```

In the same file, extend `createLangfuseClient`'s input type with `traceTags?: string[];` and insert into the `spanProcessors` array (after the plugin-version processor):

```ts
        makePluginVersionSpanProcessor(),
        ...(input.userId ? [makeUserIdSpanProcessor(input.userId)] : []),
        // VENDORED PATCH (see VENDORED.md #2)
        ...(input.traceTags?.length ? [makeTraceTagsSpanProcessor(input.traceTags)] : []),
        processor,
```

In `agent/vendor/opencode-langfuse/src/index.ts`, inside the `Effect.gen` that builds the client (right before `return yield* createLangfuseClient({`), add and pass:

```ts
    // VENDORED PATCH (see VENDORED.md #3)
    const traceTags = traceTagsFromEnv(process.env);
```

and add `traceTags,` to the `createLangfuseClient({...})` call. Add `traceTagsFromEnv` to the existing import from `./langfuse.js`.

- [ ] **Step 4: Run tests**

Run: `cd agent && bun test test/tracing.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add agent/vendor/opencode-langfuse/src/langfuse.ts agent/vendor/opencode-langfuse/src/index.ts agent/test/tracing.test.ts
git commit -m "feat: patch vendored plugin to stamp langfuse.trace.tags from repo/PR env"
```

---

### Task 3: TRACING_ENV allowlist + strip rule

**Files:**
- Modify: `agent/src/stage2/config.ts`, `agent/src/stage2/server.ts`
- Test: `agent/test/tracing.test.ts`

**Interfaces:**
- Produces: `TRACING_ENV_KEYS: readonly string[]` (7 names) and `applyTracingEnv(env: Record<string, string|undefined>): Record<string, string|undefined>` exported from `agent/src/stage2/config.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `agent/test/tracing.test.ts`:

```ts
import { TRACING_ENV_KEYS, applyTracingEnv } from "../src/stage2/config";

test("TRACING_ENV_KEYS is exactly the seven sanctioned tracing variables", () => {
  expect([...TRACING_ENV_KEYS].sort()).toEqual([
    "LANGFUSE_BASE_URL",
    "LANGFUSE_ENVIRONMENT",
    "LANGFUSE_PUBLIC_KEY",
    "LANGFUSE_SECRET_KEY",
    "LANGFUSE_TRACE_PR",
    "LANGFUSE_TRACE_REPO",
    "LANGFUSE_USER_ID",
  ]);
});

test("applyTracingEnv keeps the sanctioned vars and strips every other LANGFUSE_*/OTEL_* var", () => {
  const env: Record<string, string | undefined> = {
    LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_BASE_URL: "http://x",
    LANGFUSE_ENVIRONMENT: "code-review", LANGFUSE_USER_ID: "u@example.com",
    LANGFUSE_TRACE_REPO: "owner/repo", LANGFUSE_TRACE_PR: "66",
    LANGFUSE_BASEURL: "http://legacy",        // legacy alias — NOT sanctioned
    LANGFUSE_TRACING_ENABLED: "1",            // not part of the contract
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://evil", // must not redirect export
    OTEL_SDK_DISABLED: "true",
    ZAI_API_KEY: "keep-me",                   // unrelated — untouched
    PATH: "/bin",
  };
  const out = applyTracingEnv(env);
  expect(out).toBe(env); // mutates in place, returns the same object
  expect(out.LANGFUSE_PUBLIC_KEY).toBe("pk");
  expect(out.LANGFUSE_TRACE_PR).toBe("66");
  expect(out.LANGFUSE_BASEURL).toBeUndefined();
  expect(out.LANGFUSE_TRACING_ENABLED).toBeUndefined();
  expect(out.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  expect(out.OTEL_SDK_DISABLED).toBeUndefined();
  expect(out.ZAI_API_KEY).toBe("keep-me");
  expect(out.PATH).toBe("/bin");
});

test("applyTracingEnv with no tracing vars present is a no-op", () => {
  const env: Record<string, string | undefined> = { HOME: "/h" };
  expect(applyTracingEnv(env)).toEqual({ HOME: "/h" });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd agent && bun test test/tracing.test.ts`
Expected: FAIL — `TRACING_ENV_KEYS` not exported.

- [ ] **Step 3: Implement**

In `agent/src/stage2/config.ts`, after `HARDENED_ENV`:

```ts
/**
 * The exact set of tracing variables sanctioned to reach the spawned
 * opencode server. Everything else in the LANGFUSE_*/OTEL_* namespaces is
 * stripped before spawn (see applyTracingEnv): the plugin's bundled OTel
 * stack reads standard OTEL_* knobs, and a stray one in the job environment
 * must not silently reconfigure or redirect trace export. The legacy alias
 * LANGFUSE_BASEURL is deliberately NOT here — we set the canonical
 * LANGFUSE_BASE_URL only, so there is exactly one source of truth.
 */
export const TRACING_ENV_KEYS: readonly string[] = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_ENVIRONMENT",
  "LANGFUSE_USER_ID",
  "LANGFUSE_TRACE_REPO",
  "LANGFUSE_TRACE_PR",
];

/** Mutate `env` in place: keep the sanctioned tracing keys, delete every
 *  other LANGFUSE_*/OTEL_* key. Returns the same object for chaining. */
export function applyTracingEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  for (const k of Object.keys(env)) {
    if (!k.startsWith("LANGFUSE_") && !k.startsWith("OTEL_")) continue;
    if (TRACING_ENV_KEYS.includes(k)) continue;
    delete env[k];
  }
  return env;
}
```

In `agent/src/stage2/server.ts`, in `startServer` immediately after the `HARDENED_ENV` loop (and update the file's import):

```ts
  // Tracing: pass through EXACTLY the sanctioned LANGFUSE_* set and strip
  // everything else in the LANGFUSE_/OTEL_ namespaces before the child
  // inherits the environment.
  applyTracingEnv(process.env as Record<string, string | undefined>);
```

- [ ] **Step 4: Run tests**

Run: `cd agent && bun test test/tracing.test.ts && bun test`
Expected: tracing tests PASS; whole suite unchanged (184+ pass, same 4 local integration failures).

- [ ] **Step 5: Commit**

```bash
git add agent/src/stage2/config.ts agent/src/stage2/server.ts agent/test/tracing.test.ts
git commit -m "feat: exact-allowlist threading of LANGFUSE_* env to the spawned server"
```

---

### Task 4: experimental.openTelemetry in buildConfig

**Files:**
- Modify: `agent/src/stage2/config.ts` (buildConfig)
- Test: `agent/test/tracing.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { buildConfig } from "../src/stage2/config";

test("buildConfig enables experimental.openTelemetry and adds nothing else at top level beyond the known keys", () => {
  const c: any = buildConfig({ model: "zai-coding-plan/glm-5.2", systemPrompt: "P", steps: 4 });
  expect(c.experimental).toEqual({ openTelemetry: true });
});
```

- [ ] **Step 2: Verify failure** — Run: `cd agent && bun test test/tracing.test.ts` → FAIL (`experimental` undefined).

- [ ] **Step 3: Implement** — in `buildConfig`'s returned object, add as the first key:

```ts
    // Required by the Langfuse plugin's documented setup (upstream only
    // warns without it, but we follow the documented contract).
    experimental: { openTelemetry: true } as const,
```

- [ ] **Step 4: Verify pass** — Run: `cd agent && bun test test/tracing.test.ts && bun test`

- [ ] **Step 5: Commit**

```bash
git add agent/src/stage2/config.ts agent/test/tracing.test.ts
git commit -m "feat: enable experimental.openTelemetry in the agent config"
```

---

### Task 5: Live probe on the mini (GATE — do not proceed to Task 6+ on failure)

**Files:**
- Create (on mini, gitignored scratch): `/Users/draco/projects/ci-automation/.superpowers/sdd/langfuse-plugin-probe.md`
- No repo files changed.

**Interfaces:**
- Consumes: branch `langfuse-tracing` pushed to origin; real Langfuse keys (in transcript); zai auth present for draco on the mini.

- [ ] **Step 1: Push the branch and sync the mini**

```bash
git push -u origin langfuse-tracing
ssh mini 'cd /Users/draco/projects/ci-automation && git fetch origin && git checkout langfuse-tracing && cd agent && bun install'
```

- [ ] **Step 2: Run the probe through the production path (startServer)**

On the mini, create `/Users/draco/projects/ci-automation/.superpowers/sdd/langfuse-probe.ts`:

```ts
// Probe: spawn the hardened server exactly as production does, with real
// Langfuse creds + labels, drive ONE tiny model turn through the production
// prompt helper, close, then check Langfuse.
import { startServer } from "../../agent/src/stage2/server";
import { buildConfig } from "../../agent/src/stage2/config";
import { promptWithFormat } from "../../agent/src/stage2/prompt";

const REPO = "/tmp/probe-target"; // created by the shell step below

process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-23c53c27-d493-4732-89ad-024addd4d9e1";
process.env.LANGFUSE_SECRET_KEY = "sk-lf-30384fcf-0489-4a24-b743-aaf5f24ceee6";
process.env.LANGFUSE_BASE_URL = "http://127.0.0.1:3000";
process.env.LANGFUSE_ENVIRONMENT = "code-review";
process.env.LANGFUSE_USER_ID = "praveensingh2897@gmail.com";
process.env.LANGFUSE_TRACE_REPO = "probe/pulsedb";
process.env.LANGFUSE_TRACE_PR = "9999";

const configDir = new URL("../../agent/.opencode", import.meta.url).pathname;
const h = await startServer({
  configDir,
  config: buildConfig({
    model: "zai-coding-plan/glm-5.2",
    systemPrompt: "You are a probe. Reply with exactly: OK",
    steps: 2,
  }),
  timeoutMs: 60_000,
});
try {
  const created: any = await h.client.session.create({
    body: { title: "langfuse-probe" },
    query: { directory: REPO },
  });
  const id = created?.data?.id;
  console.log("session", id);
  const res = await promptWithFormat(h.client, id, {
    agent: "code-review",
    parts: [{ type: "text", text: "Reply with exactly: OK" }],
  });
  console.log("prompt error:", (res as any)?.error?.name ?? "none");
} finally {
  h.close();
}
console.log("probe done — now query Langfuse for the trace");
```

Run it (target repo + probe):

```bash
ssh mini 'mkdir -p /tmp/probe-target && cd /tmp/probe-target && [ -f lib.rs ] || echo "pub fn probe() {}" > lib.rs && cd /Users/draco/projects/ci-automation && bun run .superpowers/sdd/langfuse-probe.ts'
```

- [ ] **Step 3: Verify the trace landed with all labels**

```bash
ssh mini 'curl -sS -u "pk-lf-23c53c27-d493-4732-89ad-024addd4d9e1:sk-lf-30384fcf-0489-4a24-b743-aaf5f24ceee6" "http://127.0.0.1:3000/api/public/traces?tags=pr-9999&limit=5"' | python3 -m json.tool | head -60
```

Expected: a trace whose `environment` is `code-review`, `userId` `praveensingh2897@gmail.com`, tags containing `probe/pulsedb` and `pr-9999`, with generation/usage content.

- [ ] **Step 4: Record + gate**

Write findings to `.superpowers/sdd/langfuse-plugin-probe.md` on the mini (env, versions, trace id, flush behavior: did the trace appear immediately after close, or only after a delay?). If NO trace: debug event flow (check `~/.local/share/opencode/log/` for plugin errors), try `LANGFUSE_BASEURL` alias, verify plugin loaded at all. Do NOT proceed to Task 6 until a trace lands.

- [ ] **Step 5: Commit nothing (scratch only). Clean the probe target**

```bash
ssh mini 'rm -rf /tmp/probe-target /Users/draco/projects/ci-automation/.superpowers/sdd/langfuse-probe.ts'
```

---

### Task 6: Workflow wiring in droid.yml

**Files:**
- Modify: `.github/workflows/droid.yml` (the `Run review agent` step)

- [ ] **Step 1: Extend the step env and source the helper creds**

In the `Run review agent` step, extend `env:` with:

```yaml
          # Tracing labels (values are already validated upstream in the
          # validate job: owner/repo charset, numeric PR).
          LANGFUSE_ENVIRONMENT: ${{ matrix.automation }}
          LANGFUSE_USER_ID: praveensingh2897@gmail.com
          LANGFUSE_TRACE_REPO: ${{ needs.validate.outputs.target_repo || github.repository }}
          LANGFUSE_TRACE_PR: ${{ needs.validate.outputs.comment_issue }}
```

and insert at the top of `run:`, after the `unset` line:

```bash
          # Best-effort Langfuse credentials from the root-owned helper.
          # Self-hosted only; a hosted runner (or a missing helper) sources
          # an empty stream and the run proceeds untraced — by design.
          set -a
          . <(sudo -n /usr/local/libexec/pulseai-mint-token langfuse-creds 2>/dev/null) || true
          set +a
```

- [ ] **Step 2: Lint the workflow YAML**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/droid.yml')); print('yaml ok')"`
Expected: `yaml ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/droid.yml
git commit -m "feat: wire Langfuse creds + trace labels into the review agent step"
```

---

### Task 7: Root-side install (hub repo + mini)

**Files:**
- Create: `draco-hub-macos-server/scripts/install-langfuse-keys.sh` (in the hub repo — PRIVATE)
- Modify: `draco-hub-macos-server/scripts/install-mint-helper.sh` (add the `langfuse-creds` case to the generated helper)

**Interfaces:**
- Produces on the mini: `/usr/local/etc/pulseai-ci/langfuse.env` (root:wheel 0400) and the `langfuse-creds` subcommand on `/usr/local/libexec/pulseai-mint-token`.

- [ ] **Step 1: Extend install-mint-helper.sh's generated helper**

Inside the `cat >"$HELPER" <<'HELPER_EOF'` heredoc: extend `usage()` to list `langfuse-creds`, and add a case before `*) usage ;;`:

```sh
  langfuse-creds)
    # Prints KEY=VALUE lines for sourcing by the CI job. Values come from a
    # root-owned file; the subcommand takes NO arguments and cannot be
    # widened by a caller (same rule as every other subcommand).
    ENVF="/usr/local/etc/pulseai-ci/langfuse.env"
    [ -r "$ENVF" ] || { echo "langfuse.env not installed" >&2; exit 3; }
    grep -E '^(LANGFUSE_PUBLIC_KEY|LANGFUSE_SECRET_KEY|LANGFUSE_BASE_URL)=' "$ENVF"
    ;;
```

- [ ] **Step 2: Create install-langfuse-keys.sh**

```bash
#!/usr/bin/env bash
# Install the root-owned Langfuse credential file for the review agent's
# tracing, and regenerate the mint helper with the langfuse-creds subcommand.
#
# Keys are passed via ENVIRONMENT at install time — they are never committed:
#   sudo env LANGFUSE_PUBLIC_KEY=pk-... LANGFUSE_SECRET_KEY=sk-... \
#        ./scripts/install-langfuse-keys.sh
# LANGFUSE_BASE_URL defaults to the runner-local loopback endpoint.
set -euo pipefail

ENVF="/usr/local/etc/pulseai-ci/langfuse.env"
HELPER_SCRIPT="$(cd "$(dirname "$0")" && pwd)/install-mint-helper.sh"

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo env ...)." >&2; exit 1; }
: "${LANGFUSE_PUBLIC_KEY:?set LANGFUSE_PUBLIC_KEY}"
: "${LANGFUSE_SECRET_KEY:?set LANGFUSE_SECRET_KEY}"
LANGFUSE_BASE_URL="${LANGFUSE_BASE_URL:-http://127.0.0.1:3000}"

mkdir -p "$(dirname "$ENVF")"
printf 'LANGFUSE_PUBLIC_KEY=%s\nLANGFUSE_SECRET_KEY=%s\nLANGFUSE_BASE_URL=%s\n' \
  "$LANGFUSE_PUBLIC_KEY" "$LANGFUSE_SECRET_KEY" "$LANGFUSE_BASE_URL" > "$ENVF"
chown root:wheel "$ENVF"; chmod 0400 "$ENVF"
echo "installed $ENVF (root:wheel 0400)"

# Regenerate the helper so langfuse-creds exists (idempotent; the generator
# is the single source of truth for the helper).
"$HELPER_SCRIPT"

# Self-test as the runner user: mint and validate shape.
OUT="$(sudo -u github-runner sudo -n /usr/local/libexec/pulseai-mint-token langfuse-creds | tr -d '[:space:]')"
echo "$OUT" | grep -q '^LANGFUSE_PUBLIC_KEY=pk-' || { echo "helper output malformed" >&2; exit 1; }
echo "$OUT" | grep -q 'LANGFUSE_BASE_URL=http://127.0.0.1:3000' || { echo "base url wrong" >&2; exit 1; }
echo "langfuse-creds verified as github-runner (values not shown)"
```

`chmod +x` it. Commit in the hub repo (check its branch state first; follow its conventions).

- [ ] **Step 3: Run on the mini**

```bash
ssh mini 'cd /Users/draco/projects/draco-hub-macos-server && git pull --ff-only && \
  sudo env LANGFUSE_PUBLIC_KEY=pk-lf-23c53c27-d493-4732-89ad-024addd4d9e1 \
              LANGFUSE_SECRET_KEY=sk-lf-30384fcf-0489-4a24-b743-aaf5f24ceee6 \
       ./scripts/install-langfuse-keys.sh'
```

(This requires the hub commit to be pushed/pulled to the mini's checkout; if the hub repo is not a git remote of the mini checkout, scp the scripts instead and note it in the runbook.)

- [ ] **Step 4: Verify as the actual job user**

```bash
ssh mini 'sudo -u github-runner sudo -n /usr/local/libexec/pulseai-mint-token langfuse-creds | sed "s/=.*/=<redacted>/"'
```

Expected: three redacted lines. Also verify `~github-runner` still has no `~/.config/opencode/plugin/` or `tools/` dirs (hygiene rule from the discovery doc): `ssh mini 'sudo ls /Users/github-runner/.config/opencode/ 2>/dev/null; sudo ls /Users/github-runner/.opencode 2>/dev/null; echo hygiene-checked'`.

---

### Task 8: Integration tests (mini)

**Files:**
- Create: `agent/test/langfuse.integration.test.ts`

- [ ] **Step 1: Write the tests (version-gated)**

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../src/stage2/config";
import { startServer } from "../src/stage2/server";

const OPENCODE_AVAILABLE = !!Bun.which("opencode");
function serverVersion(): string {
  try { return Bun.spawnSync(["opencode", "--version"]).stdout.toString().trim(); }
  catch { return ""; }
}
// The dev MacBook runs opencode 1.18.x; the SDK pin is 1.17.8. Gate so the
// tests SKIP locally instead of failing (startServer's skew guard throws).
const PINNED = OPENCODE_AVAILABLE && serverVersion().startsWith("1.17.");

function snapshotLangfuseEnv() {
  const snap: Record<string, string | undefined> = {};
  for (const k of Object.keys(process.env)) if (k.startsWith("LANGFUSE_") || k.startsWith("OTEL_")) snap[k] = process.env[k];
  return snap;
}
function setFakeTracingEnv() {
  for (const k of Object.keys(process.env)) if (k.startsWith("LANGFUSE_") || k.startsWith("OTEL_")) delete (process.env as any)[k];
  process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-fake";
  process.env.LANGFUSE_SECRET_KEY = "sk-lf-fake";
  // Unreachable loopback port: export attempts fail without any network
  // egress; OTel logs the failure, the plugin never throws into the server.
  process.env.LANGFUSE_BASE_URL = "http://127.0.0.1:9";
  process.env.LANGFUSE_ENVIRONMENT = "test";
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:9/evil"; // must be STRIPPED
}

function makeTargetRepo(markerAbsPath: string): string {
  const repo = mkdtempSync(join(tmpdir(), "lf-sec-target-"));
  const sh = (cmd: string) => Bun.spawnSync(["bash", "-lc", cmd], { cwd: repo });
  sh("git init -q . && git config user.email t@t && git config user.name t");
  mkdirSync(join(repo, ".opencode", "tools"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "main.rs"), "fn main() {}\n");
  writeFileSync(join(repo, ".opencode", "tools", "marker.ts"),
    `import { writeFileSync } from "fs";\n` +
    `writeFileSync(${JSON.stringify(markerAbsPath)}, "executed");\n` +
    `export default { description: "m", args: {}, async execute() { return "ok"; } };\n`);
  sh("git add -A && git commit -qm base");
  return repo;
}

test.skipIf(!PINNED)(
  "hardened spawn WITH the Langfuse plugin present: server boots, probe 200, PR code-exec still closed",
  async () => {
    const marker = join(tmpdir(), `lf-marker-${process.pid}-${Date.now()}.txt`);
    const target = makeTargetRepo(marker);
    const snap = snapshotLangfuseEnv();
    setFakeTracingEnv();
    // The REAL agent config dir — the vendored plugin loads from it exactly
    // as production. Bun's node_modules walk-up resolves its deps.
    const configDir = new URL("../.opencode", import.meta.url).pathname;
    try {
      const h = await startServer({
        config: buildConfig({ model: "zai-coding-plan/glm-5.2", systemPrompt: "P", steps: 4 }),
        configDir,
        timeoutMs: 60_000,
      });
      try {
        const probe = (await h.client.config.get()) as any;
        expect(probe?.response?.status).toBe(200);
        const ids: any = await h.client.tool.ids({ query: { directory: target } });
        const list = ids?.data ?? ids;
        const names = JSON.stringify(list);
        expect(names).toContain("read_symbol");
        expect(names).toContain("grep_bounded");
        expect(names).not.toContain("marker");
      } finally { h.close(); }
      expect(existsSync(marker)).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(snap)) {
        if (v === undefined) delete (process.env as any)[k];
        else (process.env as any)[k] = v;
      }
      rmSync(target, { recursive: true, force: true });
      rmSync(marker, { force: true });
    }
  },
  90_000,
);
```

- [ ] **Step 2: Run locally — must SKIP**

Run: `cd agent && bun test test/langfuse.integration.test.ts`
Expected: `(skip)` on the MacBook (1.18.13 ≠ 1.17.x).

- [ ] **Step 3: Run on the mini — must PASS**

```bash
ssh mini 'cd /Users/draco/projects/ci-automation/agent && bun test test/langfuse.integration.test.ts'
```

Expected: 1 pass.

- [ ] **Step 4: Commit**

```bash
git add agent/test/langfuse.integration.test.ts
git commit -m "test: mini-gated integration test — plugin present, hardening intact"
```

---

### Task 9: AGENTS.md documentation

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Add a "Langfuse tracing" section** (after "Genuine per-project friction", before "Pinning and upgrading"): document (a) what traces and where the project lives, (b) the env contract — the seven sanctioned vars + strip rule, the labels mapping (environment = automation kind, userId, tags repo/pr-N), (c) the credential path — root-owned `langfuse.env` + `langfuse-creds` helper subcommand, installed by `scripts/install-langfuse-keys.sh` in the hub repo, never in this repo, (d) degrade behavior — three layers, hosted runners untraced by design, (e) traps: `LANGFUSE_BASE_URL` (underscore) vs the wrong `LANGFUSE_BASEURL` name on the Langfuse docs page; dev MacBook opencode 1.18.13 → integration tests skip locally; vendored plugin rebase procedure pointer to `agent/vendor/opencode-langfuse/VENDORED.md`.
- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: Langfuse tracing setup and env contract"
```

---

### Task 10: E2E acceptance — real PR run

**Files:** none in repo (operational).

- [ ] **Step 1: Merge dance** — push branch, open PR to `pulseai-labs/ci-automation`, get the merge SHA (or, pre-merge, use the branch-head SHA).
- [ ] **Step 2: Point a consumer at it** — temporarily bump `pulsedb-internal`'s `droid.yml` `uses:` SHA to the new commit; open a trivial PR on PulseDB (or re-run an existing one) so the code-review automation fires on the mini.
- [ ] **Step 3: Verify** — query the `ci-automation` Langfuse project (`/api/public/traces?tags=pr-<n>`) and confirm a trace with `environment=code-review`, the userId, repo + `pr-<n>` tags, and real generation/usage content. Screenshot/record trace id.
- [ ] **Step 4: Restore/keep pin** — if merged, bump consumers properly per the pinning section of AGENTS.md; if the temporary pin was pre-merge, revert it or fast-forward it to the merged SHA.

**Acceptance (from the brief):** a real trace with content visible in the `ci-automation` project from a test PR run, and AGENTS.md documenting the setup. ✓ after Task 9 + this task.
