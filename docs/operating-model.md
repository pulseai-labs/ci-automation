# Operating model — MacBook → Mac mini

How development and deployment of this repo actually works. Facts verified
2026-08-27; environment facts drift, so re-probe anything load-bearing.

## Dev / deploy loop

- **Dev happens on the MacBook** checkout of this repo.
- **Deploy = merge to `main` + consumer pin bump.** After ANY merge here run
  `scripts/bump-consumer-pins.sh` in `draco-hub-macos-server` (add `--merge`
  to auto-merge the PRs it opens). Discovery is live, no list to maintain.
- **Test only at merged-main SHAs.** A pin to an unmerged branch SHA makes
  `github.job_workflow_sha` resolve empty and the hub's self-checkout
  silently falls back to `main` (AGENTS.md trap table, cost a day).

## The mini

- `ssh mini` → `draco@dracos-mac-mini-1.tail71316d.ts.net`, passwordless sudo.
  macOS 26.x. GitHub Actions jobs run as user **`github-runner`**, not draco.
- Langfuse UI: `http://127.0.0.1:3000` on the mini (Tailscale URL from the
  MacBook). Ingestion is loopback from the runner.
- opencode on the mini is **1.17.8** (`/opt/homebrew/bin/opencode`); this
  repo pins that version. The MacBook runs 1.18.x, so integration tests
  version-gate and SKIP locally by design. Run the full suite over SSH:
  PATH needs `~/.bun/bin` and `/opt/homebrew/bin`.

### Per-user tool paths

| Path | Who | What |
| --- | --- | --- |
| `/opt/homebrew/bin/bun` (~/.bun/bin for draco) | draco | bun |
| `/usr/local/bin/bun` | github-runner | bun |
| `/opt/homebrew/bin/opencode` | both | opencode 1.17.8 |

Non-interactive SSH has a minimal PATH (`/Users/draco/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin`)
— homebrew and bun are NOT on it; use absolute paths or export PATH first.

### Tool inventory relevant to review-agent work (probed 2026-08-27)

Present under `/opt/homebrew/bin`: node v25.3.0 (+npm/npx), python3.13,
python3.14, uv/uvx, semgrep + pysemgrep, gitleaks, rg, go.
Also: system python3 3.9.6 at `/usr/bin/python3`; bash/sh always present.

**Absent:** ruff, eslint, tsc/deno — no Python or TypeScript linter/typechecker
is installed anywhere on the box. Any deterministic linting for those languages
either installs tools one-time (brew/npm -g), fetches pinned copies at job time
(uvx caches wheels; npx downloads), or relies on built-in checks only
(`python3 -m py_compile`, `bash -n`) with graceful degrade.

## Network fragility

The house link (Airtel) has an outage pattern where CDN-heavy sites work but
GitHub is dead. Wi-Fi DNS is set manually (1.1.1.1 / 8.8.8.8) to mitigate.
When GitHub is unreachable anyway: ship commits as a git bundle over scp and
apply on the other side. Retry transient curl failures in CI (weak Wi-Fi).

## Storage topology warning

draco's projects on the mini live on a second APFS volume:
`/Users/draco/projects -> /Volumes/master_ssd/projects` (disk7s2).
On 2026-08-27 this volume went into a wedged state — mounted, but every read
under it returns `EINTR` ("Interrupted system call"), even under sudo; it is
not a permissions problem. Anything stored only there (e.g. the gitignored
`.superpowers/sdd/` probe docs) is inaccessible until it is remounted/repaired.
Do NOT attempt remote disk surgery over SSH without the operator.

## Conventions

- House TDD: `bun test`; unit tests green locally, integration tests on the mini.
- Agent-side session memory lives in ZCode memory files; this repo is the
  durable record. CLAUDE.md / memory-bank scaffolding deliberately does not
  exist yet (operator deferred).
