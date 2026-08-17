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
4. `src/langfuse.ts` — generation spans additionally carry the GenAI
   semantic-convention attributes (`gen_ai.request.model`, `gen_ai.system`,
   `gen_ai.usage.*`) via `genAiObservationAttributes`, and
   `langfuse.observation.cost_details` is OMITTED when the cost is 0 — an
   explicit zero-cost override suppresses price computation from the
   project's custom model price table.

## Rebase procedure

Diff `src/` here against the new upstream tag; the three patches above are
the only local deltas. Re-apply them by hand; never bundle the dist.
