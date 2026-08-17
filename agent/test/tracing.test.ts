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
    LANGFUSE_BASEURL: "http://legacy",          // legacy alias — NOT sanctioned
    LANGFUSE_TRACING_ENABLED: "1",              // not part of the contract
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://evil", // must not redirect export
    OTEL_SDK_DISABLED: "true",
    ZAI_API_KEY: "keep-me",                     // unrelated — untouched
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

import { buildConfig } from "../src/stage2/config";

test("buildConfig enables experimental.openTelemetry for the Langfuse plugin", () => {
  const c: any = buildConfig({ model: "zai-coding-plan/glm-5.2", systemPrompt: "P", steps: 4 });
  expect(c.experimental).toEqual({ openTelemetry: true });
});

test("buildConfig registers the plugin as an explicit path spec when given, empty array when not", () => {
  const withEntry: any = buildConfig({
    model: "m", systemPrompt: "P",
    pluginEntry: "file:///abs/path/agent/.opencode/plugin/langfuse.ts",
  });
  expect(withEntry.plugin).toEqual(["file:///abs/path/agent/.opencode/plugin/langfuse.ts"]);
  const without: any = buildConfig({ model: "m", systemPrompt: "P" });
  expect(without.plugin).toEqual([]);
});
