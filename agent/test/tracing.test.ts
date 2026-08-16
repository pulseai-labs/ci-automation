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
