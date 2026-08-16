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
