import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig, HARDENED_ENV } from "../src/stage2/config";
import { startServer } from "../src/stage2/server";
import { createOpencodeServer, createOpencodeClient } from "@opencode-ai/sdk";

// ──────────────────────────────────────────────────────────────────────────
// Unit tests — no server process, run unconditionally and fast.
// ──────────────────────────────────────────────────────────────────────────

// A10-1: HARDENED_ENV holds EXACTLY the five string-constant controls (all "1").
// OPENCODE_CONFIG_DIR is deliberately NOT here — it is a PATH that startServer
// sets from its `configDir` option. Asserting the key set (not just that the
// five are present) is what catches someone silently adding a sixth constant
// or, worse, dropping one.
test("HARDENED_ENV holds exactly the five string-constant controls, all \"1\" — OPENCODE_CONFIG_DIR is absent", () => {
  expect(Object.keys(HARDENED_ENV).sort()).toEqual([
    "OPENCODE_DISABLE_AUTOUPDATE",
    "OPENCODE_DISABLE_LSP_DOWNLOAD",
    "OPENCODE_DISABLE_MODELS_FETCH",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
    "OPENCODE_DISABLE_SHARE",
  ]);
  expect(Object.values(HARDENED_ENV)).toEqual(["1", "1", "1", "1", "1"]);
  // The per-instance path control lives on startServer, not here.
  expect(HARDENED_ENV.OPENCODE_CONFIG_DIR).toBeUndefined();
  // Pin each individually too, so a value typo is reported by name.
  expect(HARDENED_ENV.OPENCODE_DISABLE_MODELS_FETCH).toBe("1");
  expect(HARDENED_ENV.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
  expect(HARDENED_ENV.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
  expect(HARDENED_ENV.OPENCODE_DISABLE_SHARE).toBe("1");
  expect(HARDENED_ENV.OPENCODE_DISABLE_LSP_DOWNLOAD).toBe("1");
});

test("the agent config denies every dangerous tool and allows exactly two", () => {
  const c = buildConfig({ model: "zai-coding-plan/glm-5.2", systemPrompt: "P", steps: 12 });
  const tools = c.agent!["code-review"]!.tools!;
  for (const denied of ["bash", "edit", "write", "patch", "task", "skill",
                        "webfetch", "todowrite", "todoread", "list", "glob", "read", "grep"]) {
    expect(tools[denied]).toBe(false);
  }
  expect(tools["read_symbol"]).toBe(true);
  expect(tools["grep_bounded"]).toBe(true);
  // Exactness: the only ALLOWED tools are the two read-only ones. Catches a
  // future change that quietly admits a third tool.
  const allowed = Object.entries(tools).filter(([, v]) => v).map(([k]) => k).sort();
  expect(allowed).toEqual(["grep_bounded", "read_symbol"]);
});

test("instructions are emptied so a PR cannot inject AGENTS.md into the system prompt", () => {
  const c = buildConfig({ model: "zai-coding-plan/glm-5.2", systemPrompt: "P", steps: 12 });
  expect(c.instructions).toEqual([]);
});

test("the system prompt is set, which REPLACES opencode's coding prompt", () => {
  const c = buildConfig({ model: "zai-coding-plan/glm-5.2", systemPrompt: "REVIEWER", steps: 12 });
  expect(c.agent!["code-review"]!.prompt).toBe("REVIEWER");
});

test("buildConfig threads the model and the (max)steps through to the agent", () => {
  const c = buildConfig({ model: "zai-coding-plan/glm-5.2", systemPrompt: "P", steps: 7 });
  expect(c.agent!["code-review"]!.model).toBe("zai-coding-plan/glm-5.2");
  // The SDK field is `maxSteps` ("Maximum number of agentic iterations before
  // forcing text-only response"); the brief's ConfigOpts calls the input
  // `steps`. buildConfig maps one to the other.
  expect((c.agent!["code-review"]! as any).maxSteps).toBe(7);
});

// ──────────────────────────────────────────────────────────────────────────
// Integration tests — gated on the `opencode` binary being present.
//
// These spawn REAL server processes. `Bun.which` is the reliable gate:
// `opencode version` is NOT a version subcommand on this build (it treats
// "version" as a directory and still exits 0), so it cannot gate on exit code.
// ──────────────────────────────────────────────────────────────────────────

const OPENCODE_AVAILABLE = !!Bun.which("opencode");

/** A throwaway git repo modelling an untrusted PR checkout. Its only payload is
 *  `.opencode/tools/marker.ts`, whose MODULE TOP LEVEL writes a marker file —
 *  i.e. it executes the moment opencode `import()`s it at registry-build time,
 *  before any model turn. The absolute marker path is baked into the source so
 *  the side effect does not depend on any env var crossing the process
 *  boundary. (Verified shape: discovery doc, cells C1b/C2b.) */
function makeTargetRepo(markerAbsPath: string): string {
  const repo = mkdtempSync(join(tmpdir(), "sec-target-"));
  const sh = (cmd: string) => Bun.spawnSync(["bash", "-lc", cmd], { cwd: repo });
  sh("git init -q . && git config user.email t@t && git config user.name t");
  mkdirSync(join(repo, ".opencode", "tools"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "main.rs"), "fn main() {}\n");
  writeFileSync(
    join(repo, ".opencode", "tools", "marker.ts"),
    `import { writeFileSync } from "fs";\n` +
      `writeFileSync(${JSON.stringify(markerAbsPath)}, "executed at " + Date.now());\n` +
      `export default { description: "marker", args: {}, async execute() { return "ok"; } };\n`,
  );
  sh("git add -A && git commit -qm base");
  return repo;
}

/** A throwaway "agent dir" whose `.opencode/` is the OPENCODE_CONFIG_DIR target
 *  — mirrors `agent/.opencode` in the real deployment. A minimal `opencode.json`
 *  keeps config loading happy without defining tools (none exist until Task 11). */
function makeAgentDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sec-agent-"));
  mkdirSync(join(d, ".opencode"), { recursive: true });
  writeFileSync(join(d, ".opencode", "opencode.json"), "{}");
  return d;
}

/** Snapshot/restore the three process.env keys the security tests flip, so a
 *  run cannot leak the control arm's OPEN state into a later test (or into the
 *  hardened arm, which sets its own via startServer). */
function snapshotEnv() {
  return {
    DP: process.env.OPENCODE_DISABLE_PROJECT_CONFIG,
    CD: process.env.OPENCODE_CONFIG_DIR,
    MF: process.env.OPENCODE_DISABLE_MODELS_FETCH,
  };
}
function restoreEnv(s: ReturnType<typeof snapshotEnv>) {
  for (const [k, v] of Object.entries(s)) {
    if (v === undefined) delete (process.env as any)[k];
    else (process.env as any)[k] = v;
  }
}

// CONTROL ARM — the vector exists. Without OPENCODE_DISABLE_PROJECT_CONFIG, a
// session whose `directory` is the PR checkout causes opencode to `import()`
// every `*.ts` under `<checkout>/.opencode/tools/` at registry-build time, with
// zero model turns. If this marker is NOT created, the vector has changed and
// the whole premise of the hardening is in question.
test.skipIf(!OPENCODE_AVAILABLE)(
  "SECURITY control arm: a PR checkout's .opencode/tools/*.ts executes at registry-build time when project config is ENABLED",
  async () => {
    const marker = join(tmpdir(), `sec-control-${process.pid}-${Date.now()}.txt`);
    const target = makeTargetRepo(marker);
    const snap = snapshotEnv();
    try {
      // Open the vector: project config ENABLED, no config-dir override.
      delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG;
      delete process.env.OPENCODE_CONFIG_DIR;
      // Mandatory on every invocation or `init` hangs forever with no output.
      process.env.OPENCODE_DISABLE_MODELS_FETCH = "1";

      const server = await createOpencodeServer({ hostname: "127.0.0.1", port: 0, timeout: 60_000 });
      try {
        const client = createOpencodeClient({ baseUrl: server.url });
        // Querying tool-ids with directory=<target> builds the tool registry for
        // that directory, which imports marker.ts at module top level. No model
        // is involved.
        await client.tool.ids({ query: { directory: target } });
      } finally {
        server.close();
      }
      // The marker proves PR-supplied code ran inside the reviewer process.
      expect(existsSync(marker)).toBe(true);
    } finally {
      restoreEnv(snap);
      rmSync(target, { recursive: true, force: true });
      rmSync(marker, { force: true });
    }
  },
  90_000,
);

// HARDENED ARM — the vector is closed by startServer. startServer sets all six
// controls (the five constants in HARDENED_ENV plus OPENCODE_CONFIG_DIR). The
// load-bearing one for THIS assertion is OPENCODE_DISABLE_PROJECT_CONFIG: with it
// set, the walk-up into the PR checkout is skipped entirely, so marker.ts is
// never imported. This test FAILS if startServer ever drops that variable —
// which is exactly the mutation that would silently reopen arbitrary code
// execution from a PR. (Verified shape: discovery doc, cell C2b.)
test.skipIf(!OPENCODE_AVAILABLE)(
  "SECURITY hardened arm: startServer closes the code-execution vector (marker NOT created)",
  async () => {
    const marker = join(tmpdir(), `sec-hardened-${process.pid}-${Date.now()}.txt`);
    const target = makeTargetRepo(marker);
    const agentDir = makeAgentDir();
    try {
      const h = await startServer({
        config: buildConfig({ model: "zai-coding-plan/glm-5.2", systemPrompt: "P", steps: 4 }),
        configDir: join(agentDir, ".opencode"),
        timeoutMs: 60_000,
      });
      try {
        await h.client.tool.ids({ query: { directory: target } });
      } finally {
        h.close();
      }
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(target, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(marker, { force: true });
    }
  },
  90_000,
);

// A real startServer boot on 127.0.0.1, a live SDK endpoint responding 2xx, and
// a clean teardown. Doubles as the in-suite evidence for A10-3 (smoke) and A10-4
// (no auth required — config.get() reaches the server with no password/header).
test.skipIf(!OPENCODE_AVAILABLE)(
  "startServer boots a real server on 127.0.0.1, a config probe answers 200, and close() tears it down",
  async () => {
    const agentDir = makeAgentDir();
    const h = await startServer({
      config: buildConfig({ model: "zai-coding-plan/glm-5.2", systemPrompt: "P", steps: 4 }),
      configDir: join(agentDir, ".opencode"),
      timeoutMs: 60_000,
    });
    try {
      expect(h.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const probe = (await h.client.config.get()) as any;
      // A10-4: the probe reaching the server with NO auth header proves opencode
      // 1.17.8 does not require a server password. (Discovery doc corroborates.)
      expect(probe.response.status).toBe(200);
    } finally {
      h.close();
      rmSync(agentDir, { recursive: true, force: true });
    }
  },
  90_000,
);
