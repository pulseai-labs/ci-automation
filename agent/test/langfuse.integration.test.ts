import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../src/stage2/config";
import { startServer } from "../src/stage2/server";

const OPENCODE_AVAILABLE = !!Bun.which("opencode");
function serverVersion(): string {
  try {
    return Bun.spawnSync(["opencode", "--version"]).stdout.toString().trim();
  } catch {
    return "";
  }
}
// The dev MacBook runs opencode 1.18.x; the SDK pin is 1.17.8 and startServer
// throws on skew. Gate so these SKIP locally instead of failing, while still
// running wherever the pinned server actually lives (the mini).
const PINNED = OPENCODE_AVAILABLE && serverVersion().startsWith("1.17.");

function snapshotTracingEnv() {
  const snap: Record<string, string | undefined> = {};
  for (const k of Object.keys(process.env))
    if (k.startsWith("LANGFUSE_") || k.startsWith("OTEL_")) snap[k] = process.env[k];
  return snap;
}
function setFakeTracingEnv() {
  for (const k of Object.keys(process.env))
    if (k.startsWith("LANGFUSE_") || k.startsWith("OTEL_")) delete (process.env as any)[k];
  process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-fake";
  process.env.LANGFUSE_SECRET_KEY = "sk-lf-fake";
  // Unreachable loopback port (discard, 9): export attempts fail with no
  // egress; OTel logs the failure, the plugin never throws into the server.
  process.env.LANGFUSE_BASE_URL = "http://127.0.0.1:9";
  process.env.LANGFUSE_ENVIRONMENT = "test";
  process.env.LANGFUSE_TRACE_REPO = "owner/repo";
  process.env.LANGFUSE_TRACE_PR = "1";
  // Unsancioned — startServer must strip this before the child inherits env.
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:9/evil";
}

function makeTargetRepo(markerAbsPath: string): string {
  const repo = mkdtempSync(join(tmpdir(), "lf-sec-target-"));
  const sh = (cmd: string) => Bun.spawnSync(["bash", "-lc", cmd], { cwd: repo });
  sh("git init -q . && git config user.email t@t && git config user.name t");
  mkdirSync(join(repo, ".opencode", "tools"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "main.rs"), "fn main() {}\n");
  writeFileSync(
    join(repo, ".opencode", "tools", "marker.ts"),
    `import { writeFileSync } from "fs";\n` +
      `writeFileSync(${JSON.stringify(markerAbsPath)}, "executed");\n` +
      `export default { description: "m", args: {}, async execute() { return "ok"; } };\n`,
  );
  sh("git add -A && git commit -qm base");
  return repo;
}

test.skipIf(!PINNED)(
  "hardened spawn WITH the Langfuse plugin present: server boots, probe 200, PR code-exec still closed",
  async () => {
    const marker = join(tmpdir(), `lf-marker-${process.pid}-${Date.now()}.txt`);
    const target = makeTargetRepo(marker);
    const snap = snapshotTracingEnv();
    setFakeTracingEnv();
    // The REAL agent config dir — the vendored plugin loads from it exactly
    // as production does (fake creds exercise the plugin's export-failure
    // path, which must stay non-fatal inside the server).
    const configDir = new URL("../.opencode", import.meta.url).pathname;
    try {
      const h = await startServer({
        config: buildConfig({ model: "zai-coding-plan/glm-5.2", systemPrompt: "P", steps: 4 }),
        configDir,
        timeoutMs: 60_000,
      });
      try {
        const probe = (await h.client.config.get()) as any;
        expect(probe?.response?.status).toBe(200);
        const ids: any = await h.client.tool.ids({ query: { directory: target } });
        const names = JSON.stringify(ids?.data ?? ids);
        expect(names).toContain("read_symbol");
        expect(names).toContain("grep_bounded");
        expect(names).not.toContain("marker");
      } finally {
        h.close();
      }
      expect(existsSync(marker)).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(snap)) {
        if (v === undefined) delete (process.env as any)[k];
        else (process.env as any)[k] = v;
      }
      rmSync(target, { recursive: true, force: true });
      rmSync(marker, { force: true });
    }
  },
  90_000,
);
