import { test, expect } from "bun:test";
import type { EvidencePack } from "../src/types";
import {
  FINDINGS_SCHEMA,
  extractFindings,
  extractUsage,
  classifyError,
  renderPack,
  reason,
} from "../src/stage2/run";
import type { ServerHandle } from "../src/stage2/server";

// ──────────────────────────────────────────────────────────────────────────
// Brief Step 1: the five required tests.
// ──────────────────────────────────────────────────────────────────────────

test("the schema constrains findings to the Finding contract", () => {
  const props = FINDINGS_SCHEMA.properties.findings.items.properties;
  expect(Object.keys(props).sort()).toEqual([
    "category", "confidence", "failure_scenario", "line",
    "path", "rationale", "severity", "suggested_fix", "title",
  ]);
  expect(props.severity.enum).toEqual(["blocker", "major", "minor", "nit"]);
});

test("extractFindings reads AssistantMessage.structured, not structured_output", () => {
  const msg = { structured: { findings: [{ title: "x" }] } };
  expect(extractFindings(msg)).toHaveLength(1);
});

test("extractFindings returns empty when structured output is absent", () => {
  expect(extractFindings({})).toEqual([]);
});

test("extractUsage maps the tokens block", () => {
  const u = extractUsage({ tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }, cost: 0 });
  expect(u).toEqual({ input: 10, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5, cost: 0 });
});

test("classifyError maps typed error names, never prose", () => {
  expect(classifyError({ name: "ProviderAuthError" })).toContain("provider not authenticated");
  expect(classifyError({ name: "APIError" })).toContain("provider API error");
  expect(classifyError({ name: "StructuredOutputError" })).toContain("valid Finding[]");
  expect(classifyError({ name: "ContextOverflowError" })).toContain("context overflow");
  expect(classifyError(undefined)).toBe("");
});

// ──────────────────────────────────────────────────────────────────────────
// Additional exactness assertions on FINDINGS_SCHEMA (ledger T7: the enum is
// the ONLY severity gate, so it must be exact, not merely present).
// ──────────────────────────────────────────────────────────────────────────

test("FINDINGS_SCHEMA pins category to the five Category values and forbids extras", () => {
  const props = FINDINGS_SCHEMA.properties.findings.items.properties;
  expect(props.category.enum).toEqual([
    "correctness", "security", "data-loss", "api-contract", "maintainability",
  ]);
  // additionalProperties:false on both levels — the structural gate that stops
  // the model smuggling fields the verifier does not normalise.
  expect(FINDINGS_SCHEMA.additionalProperties).toBe(false);
  expect(FINDINGS_SCHEMA.properties.findings.items.additionalProperties).toBe(false);
  // Required list is the full Finding contract — a missing field must be rejected.
  // Spread first: `as const` makes `required` a readonly tuple, so .sort() (which
  // mutates) is rejected by tsc on the tuple directly.
  expect([...FINDINGS_SCHEMA.properties.findings.items.required].sort()).toEqual([
    "category", "confidence", "failure_scenario", "line",
    "path", "rationale", "severity", "suggested_fix", "title",
  ]);
});

test("extractFindings stamps source:agent and tolerates an absent findings array", () => {
  const out = extractFindings({ structured: { findings: [{ title: "t", severity: "major" }] } });
  expect(out[0].source).toBe("agent");
  // structured present but findings not an array -> empty, not a throw.
  expect(extractFindings({ structured: { findings: "nope" } })).toEqual([]);
});

test("extractUsage defaults every field to 0 when the block is missing", () => {
  expect(extractUsage({})).toEqual({
    input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
  });
});

test("classifyError covers the full typed-error set and every message flags NOT a code finding", () => {
  const names = [
    "ProviderAuthError", "APIError", "StructuredOutputError", "ContextOverflowError",
    "MessageOutputLengthError", "MessageAbortedError", "ContentFilterError", "UnknownError",
  ];
  for (const name of names) {
    const msg = classifyError({ name });
    expect(msg).toBeTruthy();
    expect(msg).toContain("NOT a code finding");
  }
});

// ──────────────────────────────────────────────────────────────────────────
// renderPack — A12-1: the post-S1/S2 data model.
// ──────────────────────────────────────────────────────────────────────────

function samplePack(over: Partial<EvidencePack> = {}): EvidencePack {
  return {
    head: "abcdef1234567890",
    diff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new",
    changed: [{ path: "src/db.rs", added: 3, removed: 1 }],
    symbols: [
      { path: "src/db.rs", name: "open", kind: "function", container: "impl PulseDB" },
      { path: "src/db.rs", name: "close", kind: "function", container: "impl PulseDB" },
    ],
    containers: [
      { path: "src/db.rs", container: "impl PulseDB", signatures: ["fn open()", "fn close()", "fn flush()"] },
    ],
    clippy: [],
    budget: { bytes: 100, capped: [] },
    degraded: [],
    ...over,
  };
}

test("renderPack lists each changed symbol as path :: container :: fn name", () => {
  const out = renderPack(samplePack());
  expect(out).toContain("  src/db.rs :: impl PulseDB :: fn open");
  expect(out).toContain("  src/db.rs :: impl PulseDB :: fn close");
});

test("renderPack emits each container's full signature set", () => {
  const out = renderPack(samplePack());
  expect(out).toContain("  src/db.rs :: impl PulseDB");
  // ALL signatures in the container are present (the model needs them to spot
  // an absence); flush() is not a changed symbol but must still appear.
  expect(out).toContain("    fn open()");
  expect(out).toContain("    fn close()");
  expect(out).toContain("    fn flush()");
});

test("renderPack explains that signatures are SIGNATURES ONLY and absences are findings", () => {
  const out = renderPack(samplePack());
  expect(out).toContain("SIGNATURES ONLY");
  expect(out).toContain("absence is a finding");
  expect(out).toContain("read_symbol");
});

test("renderPack keeps HEAD, CHANGED FILES, DIFF, PUBLIC API DELTA, clippy and truncation notes", () => {
  const out = renderPack(samplePack({
    apiDelta: "pub fn open() -> u32  [changed return type]",
    clippy: [{ severity: "minor", category: "maintainability", path: "src/db.rs", line: 9,
               title: "needless borrow", rationale: "r", failure_scenario: "f",
               suggested_fix: "s", source: "clippy", confidence: 1 }],
    budget: { bytes: 100, capped: ["diff"] },
  }));
  expect(out).toContain("HEAD: abcdef1234567890");
  expect(out).toContain("CHANGED FILES");
  expect(out).toContain("src/db.rs  +3/-1");
  expect(out).toContain("DIFF (unified, 5 lines of context)");
  expect(out).toContain("PUBLIC API DELTA");
  expect(out).toContain("pub fn open() -> u32  [changed return type]");
  expect(out).toContain("DETERMINISTIC FINDINGS (clippy, changed lines only)");
  expect(out).toContain("src/db.rs:9  needless borrow");
  expect(out).toContain("NOTE: truncated sections: diff");
});

// A12-1 requirement 4: a changed symbol whose container was trimmed by the byte
// cap is still listed; only the container block is absent.
test("renderPack tolerates a symbol whose container was trimmed (no matching container entry)", () => {
  const out = renderPack(samplePack({
    // symbols reference impl PulseDB, but the container was dropped entirely.
    containers: [],
  }));
  // The symbol is still listed...
  expect(out).toContain("src/db.rs :: impl PulseDB :: fn open");
  // ...and there is no container block for it.
  expect(out).not.toContain("CONTAINER SIGNATURES:\n\n  src/db.rs :: impl PulseDB");
});

// ──────────────────────────────────────────────────────────────────────────
// reason() — driven with a mock client so the control flow is deterministic.
// ──────────────────────────────────────────────────────────────────────────

interface MockOpts {
  sessionId?: string;
  createResult?: any;   // overrides session.create's return (default: { data: { id } })
  promptResult?: any;   // session.prompt's return
}

function mockHandle(opts: MockOpts): { handle: ServerHandle; createCalls: any[]; promptCalls: any[] } {
  const createCalls: any[] = [];
  const promptCalls: any[] = [];
  const client: any = {
    session: {
      create: async (o: any) => { createCalls.push(o); return opts.createResult ?? { data: { id: opts.sessionId ?? "ses_mock" } }; },
      prompt: async (o: any) => { promptCalls.push(o); return opts.promptResult; },
    },
  };
  return { handle: { client, url: "http://mock", close() {} } as unknown as ServerHandle, createCalls, promptCalls };
}

const SUCCESS_PROMPT = {
  data: {
    info: {
      structured: { findings: [{ severity: "major", category: "correctness", path: "a.rs", line: 1, title: "t", rationale: "r", failure_scenario: "fs", suggested_fix: "sf", confidence: 0.9 }] },
      tokens: { input: 5, output: 6, reasoning: 7, cache: { read: 8, write: 9 } },
      cost: 3,
    },
    parts: [],
  },
  error: undefined,
  response: { status: 200 },
};

test("reason() returns findings and usage on a successful structured turn", async () => {
  const { handle } = mockHandle({ promptResult: SUCCESS_PROMPT });
  const out = await reason(handle, samplePack(), "/repo");
  expect(out.findings).toHaveLength(1);
  expect(out.findings[0].source).toBe("agent");
  expect(out.usage).toEqual({ input: 5, output: 6, reasoning: 7, cacheRead: 8, cacheWrite: 9, cost: 3 });
});

test("reason() scopes the session to repo and titles it from HEAD", async () => {
  const { handle, createCalls } = mockHandle({ promptResult: SUCCESS_PROMPT });
  await reason(handle, samplePack(), "/abs/repo");
  expect(createCalls[0].query.directory).toBe("/abs/repo");
  expect(createCalls[0].body.title).toBe("code-review abcdef123456");
});

// A12-2: tools must be re-enabled in the prompt body or the agent's
// permission:"*" deny suppresses them (Task 11 canary).
test("reason() passes tools: { read_symbol, grep_bounded } AND format AND agent in the prompt body", async () => {
  const { handle, promptCalls } = mockHandle({ promptResult: SUCCESS_PROMPT });
  await reason(handle, samplePack(), "/repo");
  const body = promptCalls[0].body;
  expect(body.tools).toEqual({ read_symbol: true, grep_bounded: true });
  expect(body.agent).toBe("code-review");
  expect(body.format).toEqual({ type: "json_schema", schema: FINDINGS_SCHEMA, retryCount: 2 });
  expect(Array.isArray(body.parts)).toBe(true);
});

// ── A12-3 fail-closed tests ────────────────────────────────────────────────
// The brief's original code returned { findings: [], usage: zero } for any
// `res` with no `res.data`. These prove an error now THROWS instead.

test("reason() throws on a top-level SDK error (res.error) — never a clean PASS", async () => {
  const { handle } = mockHandle({
    promptResult: { data: undefined, error: { name: "APIError", data: { message: "boom" } }, response: { status: 502 } },
  });
  await expect(reason(handle, samplePack(), "/repo")).rejects.toThrow(/NOT a code finding/);
});

test("reason() throws on res.error even for an UNRECOGNISED error name (fail-closed)", async () => {
  const { handle } = mockHandle({
    promptResult: { data: undefined, error: { name: "SomethingNewError" }, response: { status: 500 } },
  });
  await expect(reason(handle, samplePack(), "/repo")).rejects.toThrow(/SomethingNewError.*NOT a code finding/);
});

test("reason() throws on an in-body StructuredOutputError (res.data.info.error)", async () => {
  // Empirically observed shape: HTTP 200, res.error undefined, error on info.
  const { handle } = mockHandle({
    promptResult: {
      data: { info: { error: { name: "StructuredOutputError", data: { message: "Model did not produce structured output", retries: 0 } }, tokens: {}, cost: 0 }, parts: [] },
      error: undefined,
      response: { status: 200 },
    },
  });
  await expect(reason(handle, samplePack(), "/repo")).rejects.toThrow(/valid Finding\[\]/);
});

test("reason() throws on an in-body ProviderAuthError", async () => {
  const { handle } = mockHandle({
    promptResult: {
      data: { info: { error: { name: "ProviderAuthError", data: { providerID: "zai", message: "no key" } }, tokens: {}, cost: 0 }, parts: [] },
      error: undefined,
      response: { status: 200 },
    },
  });
  await expect(reason(handle, samplePack(), "/repo")).rejects.toThrow(/not authenticated/);
});

test("reason() throws when session.create yields no session id", async () => {
  const { handle } = mockHandle({ createResult: { data: {} }, promptResult: SUCCESS_PROMPT });
  await expect(reason(handle, samplePack(), "/repo")).rejects.toThrow(/could not create an opencode session/);
});

test("reason() returns zero findings (not a throw) only when structured is genuinely empty", async () => {
  const { handle } = mockHandle({
    promptResult: {
      data: { info: { structured: { findings: [] }, tokens: {}, cost: 0 }, parts: [] },
      error: undefined,
      response: { status: 200 },
    },
  });
  const out = await reason(handle, samplePack(), "/repo");
  expect(out.findings).toEqual([]);
});
