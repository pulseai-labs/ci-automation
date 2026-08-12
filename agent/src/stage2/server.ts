import { createOpencodeServer, createOpencodeClient } from "@opencode-ai/sdk";
import { HARDENED_ENV } from "./config";

export interface ServerHandle {
  client: ReturnType<typeof createOpencodeClient>;
  url: string;
  close: () => void;
}

export interface StartServerOpts {
  config: ReturnType<typeof import("./config").buildConfig>;
  /**
   * Absolute path to the agent's `.opencode` directory (amendment A10-1 — the
   * 6th control). Tool discovery follows the SESSION directory (the PR
   * checkout), not the agent's own directory, so with
   * `OPENCODE_DISABLE_PROJECT_CONFIG=1` the agent's `read_symbol`/`grep_bounded`
   * tools would never be found. Setting `OPENCODE_CONFIG_DIR` to this path is
   * the verified-working escape hatch: it is always scanned regardless of the
   * disable flag. Must point at the `.opencode` directory itself (the tool scan
   * uses it as the glob cwd, so tools land at `$OPENCODE_CONFIG_DIR/tools/*.ts`).
   */
  configDir: string;
  /**
   * The review language the `read_symbol` tool resolves its symbol pattern
   * against (see tools/read_symbol.ts, which reads `process.env.REVIEW_LANGUAGE`
   * with a "rust" fallback). Phase 1 always reviews Rust; Phase 4+ will derive
   * this from language detection in stage 1. Setting it here makes the value
   * explicit on the process env for the spawned server child.
   */
  reviewLanguage?: string;
  port?: number;
  timeoutMs?: number;
}

/** Read the `opencode` server binary's version (`opencode --version`). Used for
 *  the SDK/server skew check. `opencode version` is NOT a version subcommand on
 *  this build (it treats "version" as a directory), so `--version` is required. */
function serverBinaryVersion(): string {
  try {
    return Bun.spawnSync(["opencode", "--version"]).stdout.toString().trim();
  } catch {
    return "";
  }
}

/**
 * Spawn the hardened opencode server and return a live client.
 *
 * Order matters: every environment control is written to `process.env` BEFORE
 * `createOpencodeServer`, because that call spawns `opencode serve` with
 * `env: { ...process.env, OPENCODE_CONFIG_CONTENT: … }` — the child inherits the
 * current process env verbatim. If `OPENCODE_DISABLE_MODELS_FETCH` is not on the
 * process env at spawn time, the child hangs forever at init with no output and
 * no timeout (discovery doc).
 */
export async function startServer(opts: StartServerOpts): Promise<ServerHandle> {
  // The five string-constant controls.
  for (const [k, v] of Object.entries(HARDENED_ENV)) process.env[k] = v;
  // The path control. Absolute and pointing at the `.opencode` dir itself.
  process.env.OPENCODE_CONFIG_DIR = opts.configDir;
  // The language control: read_symbol resolves its symbol-lookup regex from
  // this (tools/read_symbol.ts). Default "rust" — Phase 1 floor.
  process.env.REVIEW_LANGUAGE = opts.reviewLanguage ?? "rust";

  // Fail fast on SDK/server skew BEFORE spawning, rather than on a confusing
  // 404 mid-review. `--version` prints e.g. "1.17.8"; the SDK is pinned to
  // 1.17.8, so accept any 1.17.x. Empty output (binary missing/misbehaving) is
  // skipped — the spawn below will fail loudly in that case.
  const ver = serverBinaryVersion();
  if (ver && !ver.startsWith("1.17.")) {
    throw new Error(`SDK/server skew: server ${ver}, SDK pinned to 1.17.8`);
  }

  const server = await createOpencodeServer({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    timeout: opts.timeoutMs ?? 15_000,
    config: opts.config as any,
  });

  // A10-4: opencode 1.17.8 (Homebrew) does not require auth on a server spawned
  // via createOpencodeServer — the discovery doc's probe harness used direct
  // fetch with no password and no Authorization header, and it worked. So no
  // OPENCODE_SERVER_PASSWORD and no Basic-auth fetch wrapper: adding auth the
  // server does not want would only give a false sense of a control. The 200
  // liveness probe below re-verifies this on every start.
  const client = createOpencodeClient({ baseUrl: server.url });

  // Liveness + API-surface check: a real SDK endpoint must answer 2xx. This is
  // the guard against an old server that lacks an endpoint the client expects
  // (the "confusing 404 mid-review" case), and it is also where A10-4's no-auth
  // assumption is re-checked — a 401 here would mean auth IS required.
  //
  // I-1: the probe is wrapped so ANY failure tears down the child before the
  // error propagates. The non-200 branch throws inside the try (caught, closed,
  // rethrown); a *thrown* probe — connection reset, ECONNREFUSED, a fetch-layer
  // exception — is caught by the same catch and closed too. Without this, a
  // thrown probe would orphan the `opencode serve` child, and since startServer
  // is the lifecycle entry point called for every review, orphans would
  // accumulate across retries.
  try {
    const probe = (await client.config.get()) as any;
    const status = probe?.response?.status;
    if (status !== 200) {
      throw new Error(`opencode server liveness probe failed: HTTP ${status}`);
    }
  } catch (e) {
    server.close();
    throw e;
  }

  return { client, url: server.url, close: () => server.close() };
}
