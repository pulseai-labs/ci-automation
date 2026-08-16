/**
 * Langfuse observability plugin entry — the only file opencode loads by
 * path. `$OPENCODE_CONFIG_DIR/plugin/*.ts` is scanned unconditionally
 * (tool-discovery doc), so this loads under the hardening contract with no
 * changes to it. Dynamic import + catch: tracing can NEVER break a review —
 * absent dependencies, damaged files, or absent credentials all degrade to
 * a no-op plugin (upstream independently no-ops without credentials).
 *
 * The catch logs through the server's app.log channel — a silent catch here
 * once cost a full debugging cycle when the plugin failed to load only
 * inside the CI environment (probe evidence: the e2e run completed with no
 * trace and no diagnostic line).
 */
import { appendFileSync } from "node:fs";

type PluginInput = { client: any; [key: string]: any };

/** File-based diagnostics: app.log needs a live client, which an import
 *  failure may itself prevent — the only channel guaranteed to work is a
 *  file. Marker path is fixed and survives the workspace wipe. */
function mark(msg: string) {
  try {
    appendFileSync("/tmp/langfuse-plugin-load.log", `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // Diagnostics must never break the degrade path.
  }
}

export default async function langfusePlugin(input: PluginInput) {
  mark("entry invoked");
  try {
    const mod: any = await import("../../vendor/opencode-langfuse/src/index.js");
    const plugin = mod.default ?? mod.LangfusePlugin;
    const hooks = await plugin(input);
    mark("vendored plugin initialized");
    return hooks;
  } catch (e) {
    const err = e as any;
    mark(`LOAD FAILED: ${err?.message ?? String(e)}\n${err?.stack ?? ""}`);
    return {};
  }
}
