import type { EvidencePack, Finding, Usage } from "../types";
import type { ServerHandle } from "./server";
import { promptWithFormat } from "./prompt";

/**
 * The JSON schema that constrains the model's structured output.
 *
 * HARD REQUIREMENT (ledger T7): `severity` is pinned to the four Verdict-gating
 * values and `category` to the five Category values. An off-enum severity falls
 * through `deriveVerdict` to PASS — stage 3 never normalises it — so this schema
 * is the ONLY gate. `additionalProperties: false` on both the object and each
 * finding stops the model smuggling extra fields; the `required` list matches
 * the `Finding` interface field-for-field.
 */
export const FINDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "category", "path", "line", "title",
                   "rationale", "failure_scenario", "suggested_fix", "confidence"],
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor", "nit"] },
          category: { type: "string", enum: ["correctness", "security", "data-loss", "api-contract", "maintainability"] },
          path: { type: "string" },
          line: { type: "number" },
          title: { type: "string" },
          rationale: { type: "string" },
          failure_scenario: { type: "string" },
          suggested_fix: { type: "string" },
          confidence: { type: "number" },
        },
      },
    },
  },
} as const;

/**
 * Read the model's findings off an AssistantMessage.
 *
 * On a successful structured turn opencode sets `message.structured` to the
 * parsed JSON conforming to FINDINGS_SCHEMA (confirmed in the opencode binary:
 * `message.structured = <parsed>`). The SDK's `AssistantMessage` type omits the
 * `structured` field — a type gap, not an absence — so the access is untyped.
 * Each raw finding is stamped `source: "agent"` so stage 3 can attribute it.
 */
export function extractFindings(msg: any): Finding[] {
  const raw = msg?.structured?.findings;
  if (!Array.isArray(raw)) return [];
  return raw.map((f: any) => ({ ...f, source: "agent" as const }));
}

/** Map the AssistantMessage usage block onto the pipeline's `Usage` shape. */
export function extractUsage(msg: any): Usage {
  const t = msg?.tokens ?? {};
  return {
    input: t.input ?? 0, output: t.output ?? 0, reasoning: t.reasoning ?? 0,
    cacheRead: t.cache?.read ?? 0, cacheWrite: t.cache?.write ?? 0,
    cost: msg?.cost ?? 0,
  };
}

/**
 * Map a typed provider/SDK error to a human-facing reason string.
 *
 * Detection is by the error object's `name` field — NEVER by matching strings in
 * report prose. Every mapped message ends with "NOT a code finding" so an ERROR
 * verdict can never be confused with a real review failure. Returns "" for an
 * unrecognised/absent error, which `reason()` treats as "no error here".
 */
export function classifyError(err: any): string {
  switch (err?.name) {
    case "ProviderAuthError":        return "provider not authenticated — NOT a code finding";
    case "APIError":                 return "provider API error, commonly quota or rate limit — NOT a code finding";
    case "StructuredOutputError":    return "model could not produce valid Finding[] — NOT a code finding";
    case "ContextOverflowError":     return "context overflow — NOT a code finding";
    case "MessageOutputLengthError": return "model output truncated — NOT a code finding";
    case "MessageAbortedError":      return "run aborted — NOT a code finding";
    case "ContentFilterError":       return "content filtered — NOT a code finding";
    case "UnknownError":             return "unknown provider error — NOT a code finding";
    default:                         return "";
  }
}

/**
 * Render an EvidencePack into the single model-facing prompt.
 *
 * Amendment A12-1: rewritten for the post-S1/S2 data model. The brief's version
 * read `SymbolInfo.siblings` — a per-symbol signature list that duplicated an
 * entire container once per changed symbol (O(symbols × container size) and a
 * copy that drifted from the source). S1/S2 removed `siblings` and split the
 * pack into:
 *   - `pack.symbols: SymbolInfo[]`      the CHANGED functions (path/name/container)
 *   - `pack.containers: ContainerInfo[]` full signature lists, ONE per container
 *
 * The model now sees, in order: (1) every changed symbol as
 * `path :: container :: fn name`, then (2) each container's complete signature
 * set. It needs ALL signatures in a container to spot an absence — a change
 * applied to one function but missing from a sibling. Requirement 4 of A12-1: a
 * changed symbol whose `(path, container)` was trimmed by the byte cap is still
 * listed under CHANGED SYMBOLS; it simply has no container block below, which the
 * header note explains.
 */
export function renderPack(pack: EvidencePack): string {
  const parts: string[] = [
    `HEAD: ${pack.head}`,
    ``, `CHANGED FILES`,
    ...pack.changed.map(c => `  ${c.path}  +${c.added}/-${c.removed}`),
    ``, `DIFF (unified, 5 lines of context)`, pack.diff,
  ];

  if (pack.symbols.length || pack.containers.length) {
    parts.push(
      ``,
      `CHANGED SYMBOLS AND CONTAINER SIGNATURES`,
      `(These are SIGNATURES ONLY — one line per item, no bodies. The changed`,
      ` symbols are listed first; each container's full signature set follows.`,
      ` If a change should have been applied to another signature in the same`,
      ` container and was not, that absence is a finding — use read_symbol to`,
      ` confirm. A changed symbol with no container block below had its`,
      ` container trimmed by the byte cap.)`,
      ``,
      `CHANGED SYMBOLS:`,
    );
    for (const s of pack.symbols) {
      parts.push(`  ${s.path} :: ${s.container} :: fn ${s.name}`);
    }

    parts.push(``, `CONTAINER SIGNATURES:`);
    for (const c of pack.containers) {
      parts.push(``, `  ${c.path} :: ${c.container}`);
      for (const sig of c.signatures) parts.push(`    ${sig}`);
    }
  }

  if (pack.apiDelta) parts.push(``, `PUBLIC API DELTA`, pack.apiDelta);
  if (pack.clippy.length) {
    parts.push(``, `DETERMINISTIC FINDINGS (clippy, changed lines only)`);
    for (const c of pack.clippy) parts.push(`  ${c.path}:${c.line}  ${c.title}`);
  }
  if (pack.budget.capped.length) {
    parts.push(``, `NOTE: truncated sections: ${pack.budget.capped.join(", ")}`);
  }
  return parts.join("\n");
}

/**
 * Drive one structured-output model turn and return its findings + usage.
 *
 * Creates a session scoped to `repo`, sends a single prompt constrained by
 * FINDINGS_SCHEMA, and reads the structured findings off the AssistantMessage.
 *
 * Fail-closed contract (amendment A12-3): a provider/server error must NEVER
 * surface as a clean PASS with zero findings. The brief's original extraction
 * computed `msg = res?.data?.info ?? res?.data` then `classifyError(msg?.error)`;
 * when the SDK returns `{ data: undefined, error }` (an HTTP/network-level
 * failure), `msg` was null, `classifyError(undefined)` returned "", and reason()
 * returned `{ findings: [], usage: zero }` — a flawless-looking review. The
 * orchestrator's catch block never fired because nothing threw. Two error
 * surfaces are now checked, in order, BEFORE any finding is extracted:
 *
 *   (1) `res.error` — the SDK RequestResult's top-level error field, present when
 *       the request never produced a 2xx body (HTTP 400/404, fetch failure).
 *       Empirically: on a 2xx this is `undefined` and `res.data` is the body.
 *   (2) `res.data.info.error` — a typed error embedded in a 200 response body
 *       (e.g. StructuredOutputError, ProviderAuthError). A live turn confirmed a
 *       StructuredOutputError lands HERE with `res.error` undefined.
 *
 * Amendment A12-2: `tools: { read_symbol: true, grep_bounded: true }` is passed
 * in the prompt body. The agent config's `permission: { "*": "deny" }` suppresses
 * tool calls for a turn unless the body re-enables them (Task 11 canary).
 */
export async function reason(
  handle: ServerHandle,
  pack: EvidencePack,
  repo: string,
): Promise<{ findings: Finding[]; usage: Usage }> {
  const created: any = await handle.client.session.create({
    body: { title: `code-review ${pack.head.slice(0, 12)}` },
    query: { directory: repo },
  });
  const sessionID = created?.data?.id;
  if (!sessionID) throw new Error("could not create an opencode session");

  const res: any = await promptWithFormat(handle.client, sessionID, {
    agent: "code-review",
    parts: [{ type: "text", text: renderPack(pack) }],
    format: { type: "json_schema", schema: FINDINGS_SCHEMA as any, retryCount: 2 },
    // A12-2: re-enable the two read-only tools for this turn.
    tools: { read_symbol: true, grep_bounded: true },
  });

  // (1) SDK/HTTP-level error — fail-closed even for an unrecognised name.
  if (res?.error) {
    const t = classifyError(res.error);
    throw new Error(t || `opencode session.prompt error: ${res.error?.name ?? "unknown"} — NOT a code finding`);
  }

  const msg = res?.data?.info ?? res?.data;

  // (2) In-body provider/structured error (HTTP 200 with msg.error set).
  const inBody = classifyError(msg?.error);
  if (inBody) throw new Error(inBody);
  // An unrecognised in-body error name is still an error — fail-closed.
  if (msg?.error) {
    throw new Error(`opencode message error: ${msg.error?.name ?? "unknown"} — NOT a code finding`);
  }

  return { findings: extractFindings(msg), usage: extractUsage(msg) };
}
