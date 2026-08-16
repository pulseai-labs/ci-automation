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
type PluginInput = { client: any; [key: string]: any };

async function appLog(input: PluginInput, level: "info" | "error", message: string) {
  try {
    await input?.client?.app?.log?.({ body: { service: "langfuse", level, message } });
  } catch {
    // Logging must never break the degrade path.
  }
}

export default async function langfusePlugin(input: PluginInput) {
  try {
    const mod: any = await import("../../vendor/opencode-langfuse/src/index.js");
    const plugin = mod.default ?? mod.LangfusePlugin;
    return await plugin(input);
  } catch (e) {
    await appLog(input, "error", `plugin load failed: ${(e as any)?.message ?? String(e)}`);
    return {};
  }
}
