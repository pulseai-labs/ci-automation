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
