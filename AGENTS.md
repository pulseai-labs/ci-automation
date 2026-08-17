# AGENTS.md — onboarding a project to droid CI

How to add a droid automation pipeline (QA, code review, security audit) to a
project in `pulseai-labs`. Written for an agent or operator doing this without
prior context.

> **2026-08 update — code review has changed.** The `code-review` automation
> now runs a purpose-built agent (`agent/` in this repo) on opencode + glm-5.2,
> NOT droid. Droid still serves `qa` and `security-audit`. For onboarding a
> dual-repo pair to code review, the step-by-step is the `onboard-dual-repo`
> skill (Factory personal skills) — it carries the exact workflow templates,
> the permissions block that prevents `startup_failure`, and every failure
> mode hit in production. This file remains the architecture rationale and the
> reference for qa/security-audit.

## Step zero — read ground truth, do not trust this file for facts

```bash
./scripts/context.sh          # in pulseai-labs/draco-hub-macos-server
```

**No plan is valid without its output.** This document holds *rationale* — why
`workflow_dispatch` and not `repository_dispatch`, why the runner group is the
security control, what each trap was. Rationale stays true. **Facts do not**:
the hub SHA, app IDs, granted permissions, which repos run which automations,
what a required check is named. Those are resolved by the command above and are
deliberately absent here.

This is not a stylistic preference. An earlier version of this file documented
`repository_dispatch`, omitted two permissions that turned out to be required,
and pinned a SHA three commits stale — every one accurate when written. An agent
following it would have reproduced the exact failures it was written to prevent.

Architecture and rationale live in `pulseai-labs/draco-hub-macos-server`,
`docs/adr/0001-ci-automation-architecture.md`. Read that before changing
anything structural. This file is the operational how-to.

---

## The one thing to understand first

Jobs run on a **single self-hosted Mac mini**, scoped by an org runner group
(`mac-mini-private`) with `allows_public_repositories: false`.

**A public repository therefore cannot run jobs on the runner at all.** This is
deliberate and is the primary security control: a fork PR can supply its own
workflow file naming `runs-on: [self-hosted, ...]`, so no workflow-level guard
can protect the hardware. Only the group can.

Everything below follows from that single fact.

---

## Decision tree

```
Is the repository that needs automation PRIVATE?
├── YES → Pattern A (single-repo). Simplest. Nothing else needed.
└── NO (public)
    └── Does it have a private twin holding its skills?
        ├── YES → Pattern B (dual-repo). Trigger + dispatch.
        └── NO  → Create the private twin first, then Pattern B.
```

---

## What is already automatic — do NOT redo these per project

These were configured once and cover every current and future repository:

| Thing | Why it needs no per-project work |
| --- | --- |
| **GitHub App `pulseai-ci`** (worker) | Installed org-wide, `repository_selection: all`. Every repo created from now on is covered the moment it exists. Nothing to install or configure per project. |
| **Runner group membership** | `mac-mini-private` is `visibility: all` + `allows_public_repositories: false`, so every **private** repo — including ones created tomorrow — can already use the runner. No allowlist to edit. |
| **Runner credentials** | The App key lives root-owned on the runner. Jobs mint 1-hour scoped tokens through a root helper. No repo secret, no deploy key, no PAT anywhere. |
| **droid model + auth** | Configured once for the `github-runner` account on the mini. |

**If you find yourself creating a deploy key, adding a repo secret, or editing
the runner group for a new project, stop — you are working against the design.**
The only legitimate exceptions are listed under "Genuine per-project friction".

### Two apps, and why

One credential **must** live in a public repository's secrets, because a
GitHub-hosted trigger job cannot read the key on the mini. That makes it the
most exposed thing in the design — so it is also the least powerful.

| | `pulseai-ci` (**worker**) | `pulseai-ci-dispatch` (**doorbell**) |
| --- | --- | --- |
| Permissions | `contents:read`, `issues:write`, `pull_requests:write`, `metadata:read` | **`actions:write`, `metadata:read` — nothing else** |
| Installed on | all repositories | the private twins only |
| Key lives | `/usr/local/etc/pulseai-ci/app.pem` on the runner, `root:wheel 0400`. **Never in GitHub.** | a secret in each **public** canonical repo |
| Used by | the runner, via a root mint helper | the hosted trigger job |
| If exfiltrated | needs root on the mini first | can trigger QA workflows. Cannot read code, comment, or push. |

**Never put the worker key in a repository secret.** A single app holding both
roles was the original design; it was corrected after review found the key was
exfiltratable by any collaborator able to push a branch.

### Why each worker permission

| Permission | Needed for |
| --- | --- |
| `metadata: read` | Mandatory on every App. |
| `contents: read` | Checking out the skills repo and the analysis target. |
| `issues: write` | Commenting on an **issue**. |
| `pull_requests: write` | Commenting on a **pull request**. Not optional and not covered by `issues:write` — GitHub gates on the RESOURCE, not the endpoint, even though the path `/issues/{n}/comments` is shared. A token with only `issues:write` gets `403 Resource not accessible by integration` on a PR. |
| `actions: write` (dispatch app) | `workflow_dispatch` into the private twin. Deliberately NOT `contents: write`, which `repository_dispatch` would require and which is push access for an App. |

Two rules that cost real debugging time:

1. **Editing the App does not grant the permission.** It raises a *pending
   request* that each installation must approve separately, at
   the org's installations page. Until then the installation keeps its old set.
   Check the live values with `./scripts/context.sh apps` in
   `draco-hub-macos-server` — installation IDs are not recorded here, because a
   recorded ID is wrong the moment it changes.
2. **Never grant `contents: write`** to reach for a shortcut. For an App that is
   push access to all installed repos, and this App reads attacker-authored
   diffs. If something genuinely needs to write code, it belongs in a separate
   App with a separate key.

Requesting a permission the installation lacks is a **hard error at mint time**,
never a silent downgrade — so these mistakes surface as clean 403s.

---

## Pattern A — single-repo stack (private repository)

The repository holds both its code and its curated skills. This is the normal
case for the ten private repos.

**Step 1.** Curate skills in the repository:

```
.factory/skills/qa/SKILL.md
.factory/skills/qa/config.yaml          # optional, read by the skill
.factory/skills/code-review/SKILL.md    # only if you enable that automation
```

Skills are **per project on purpose**. Do not install them globally, do not
share them between projects, do not add them to this hub. A project's QA skill
encodes what *that* project considers correct.

**Step 2.** Add one file, `.github/workflows/droid.yml`:

```yaml
name: Droid Automations
on:
  pull_request:
    branches: [main]
  workflow_dispatch:
jobs:
  droid:
    uses: pulseai-labs/ci-automation/.github/workflows/droid.yml@<40-char-sha>
    with:
      automations: qa
```

That is the entire integration. No secrets, no `permissions:` block, no
`runs-on`.

**Step 3.** Open a PR and confirm the run appears. Done.

To add automations later, edit one line:
`automations: qa,code-review,security-audit`.

---

## Pattern B — dual-repo stack (public canonical + private AI workspace)

Used when the code is public — e.g. `PulseDB` (public) with `pulsedb-internal`
(private) holding its skills.

The public repo **cannot** run on the runner. So the private twin runs the job
and the public repo only *asks* it to.

```
PulseDB (public)                    pulsedb-internal (private)
  qa-trigger.yml                      droid.yml
  on: pull_request                    on: workflow_dispatch
  runs-on: ubuntu-latest      ──────► runs-on: self-hosted
  mints App token, dispatches         calls the hub, checks out PulseDB
                                      at the dispatched SHA, comments back
```

**Step 1.** Put the skills in the **private** repo: `.factory/skills/qa/…`

**Step 2.** In the **private** repo, `.github/workflows/droid.yml`:

```yaml
name: Droid Automations
on:
  workflow_dispatch:
    inputs:
      sha: { description: 'Commit SHA to analyse', required: true }
      pr:  { description: 'PR number to comment on', required: true }
jobs:
  qa:
    uses: pulseai-labs/ci-automation/.github/workflows/droid.yml@<40-char-sha>
    with:
      automations: qa
      target-repo: pulseai-labs/PulseDB
      target-ref: ${{ inputs.sha }}
      comment-on: pulseai-labs/PulseDB
      comment-issue: ${{ inputs.pr }}
```

**Use `workflow_dispatch`, not `repository_dispatch`.** Both trigger the twin,
but `POST /repos/{}/dispatches` requires the App permission `contents: write` —
and for a GitHub App that grant **is push access to every repo it is installed
on**. `POST /actions/workflows/{}/dispatches` needs only `actions: write`,
which cannot modify code. Verified the hard way: the dispatch path returned
`403 Resource not accessible by integration` until it was switched.

The hub validates `target-ref` and `comment-issue` on a hosted runner before the
mini is touched, so malformed or hostile inputs fail closed. Do not add your own
interpolation of workflow inputs into a `run:` block — pass them via `env:`.

**Step 3.** In the **public** repo, `.github/workflows/qa-trigger.yml`:

```yaml
name: QA Trigger
on:
  pull_request:
    branches: [main]
permissions:
  contents: read
jobs:
  dispatch:
    # Branch PRs only. A fork PR gets no secrets, so the token step fails and
    # the runner is never contacted — that is a platform guarantee, stronger
    # than an `if: github.actor == ...` line anyone can edit.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/create-github-app-token@v3
        id: token
        with:
          app-id: ${{ vars.PULSEAI_DISPATCH_APP_ID }}
          private-key: ${{ secrets.PULSEAI_DISPATCH_PRIVATE_KEY }}
          owner: pulseai-labs
          repositories: pulsedb-internal
          permission-actions: write
      - env:
          GH_TOKEN: ${{ steps.token.outputs.token }}
          SHA: ${{ github.event.pull_request.head.sha }}
          PR: ${{ github.event.pull_request.number }}
        run: |
          printf '%s' "$SHA" | grep -Eq '^[0-9a-f]{40}$' || { echo "::error::bad sha"; exit 1; }
          printf '%s' "$PR"  | grep -Eq '^[0-9]{1,10}$'  || { echo "::error::bad pr"; exit 1; }
          gh api -X POST \
            /repos/pulseai-labs/pulsedb-internal/actions/workflows/droid.yml/dispatches \
            -f ref=master \
            -f "inputs[sha]=$SHA" \
            -f "inputs[pr]=$PR"
```

**Step 4 — the one real per-project cost.** The public repo needs the
**dispatch** app's credentials — `PULSEAI_DISPATCH_APP_ID` (a *variable*) and
`PULSEAI_DISPATCH_PRIVATE_KEY` (a *secret*) — because a GitHub-hosted runner
cannot read the key on the mini.

**Never the worker key.** That distinction is the entire point of the two-app
split: the credential placed in a public repo can trigger one workflow in one
private repo, and nothing else. The worker key would grant read access to every
private repo in the org.

From `draco-hub-macos-server`:

```bash
./scripts/setup-dispatch-app.sh install <PublicRepoName>
./scripts/setup-dispatch-app.sh verify
```

`install` refuses to proceed if the dispatch app has picked up any permission
beyond `actions:write`. `verify` then proves the resulting key cannot read
private source, cannot comment, and covers no public repo.

**Step 5 — allowlist the comment target.** The root mint helper on the runner
hardcodes which repositories it will issue comment tokens for. A new public repo
must be added to that allowlist, on the mini, as root:

```
/usr/local/libexec/pulseai-mint-token     # edit the comment-token case list
```

This is intentional: the helper accepts no permission arguments, so the
allowlist cannot be widened by a caller. Editing it is a root action by design.

---

## New repositories created in the org

| If the new repo is… | Runner access | What you do |
| --- | --- | --- |
| **Private** | Already covered by the runner group | Pattern A. Two files. Nothing else. |
| **Public** | Blocked, permanently and deliberately | Pattern B, with its private twin. |

The App covers both automatically — `repository_selection: all` means a repo
created five minutes ago is already in scope. **There is no App step when
onboarding a new project.** If someone tells you to install or configure the App
per project, they are describing a different architecture.

---

## Genuine per-project friction (the honest list)

Everything else is automatic. These are not:

1. **The caller workflow file** — one file, ~8 lines.
2. **Curated skills** — the actual work, and the point. Not shareable.
3. **The hub SHA pin** — see below.
4. **Pattern B only:** the **dispatch** App ID variable + private key secret on
   the public repo, and the mint-helper allowlist entry. Never the worker key.

---

## Langfuse tracing of the review agent

Every `code-review` run of the custom agent traces to a dedicated
**`ci-automation`** project on the Langfuse instance self-hosted on the mini
(same machine as the runner, so ingestion is loopback). `qa` and
`security-audit` still run droid and are NOT traced; they inherit tracing
when they migrate onto the agent.

**How it is wired.** The observability plugin is vendored at
`agent/vendor/opencode-langfuse/` (upstream
`@langfuse/opencode-observability-plugin` v0.2.0 + three local patches —
see its `VENDORED.md`) with a degrade-safe entry at
`agent/.opencode/plugin/langfuse.ts`. It is registered as an explicit
`file://` path spec in the inline config (`pluginEntry` in `buildConfig`,
set by `defaultReason`) — the config channel is the one surface verified to
load inside CI jobs. A `file://` spec is a first-class opencode plugin spec
and never touches npm. The vendored copy is deliberate: the npm-spec
`plugin:` config entry would resolve and install from npm at every server
spawn, network-dependent init on weak Wi-Fi (the failure class behind
`OPENCODE_DISABLE_MODELS_FETCH`), and the tags patch has no upstream
equivalent. Before close, `defaultReason` POSTs `/instance/dispose` and
settles 3s — the plugin's dispose handler force-flushes the open turn span,
without which the trace ROOT is lost to the SIGTERM race.

**Labels.** environment = the automation kind (`qa` / `code-review` /
`security-audit`), userId = the operator's email, tags = the target repo and
`pr-<n>` — set from the workflow's validated outputs, never from raw
inputs. The tags ride a span processor patched into the vendored plugin
(`langfuse.trace.tags` is the only tag channel Langfuse makes filterable).

**Credentials — never in this repo.** Keys live in a root-owned
`/usr/local/etc/pulseai-ci/langfuse.env` (0400) on the mini, installed by
`scripts/install-langfuse-keys.sh` in `draco-hub-macos-server`. The job
captures them at run time from the mint helper (`langfuse-creds`
subcommand — no arguments, cannot be widened) with an explicit
`VAR="$(sudo -n …)"` + `export` per variable. Do NOT use the
`. <(sudo -n …)` sourcing form: sudo inside process substitution silently
fails in the Actions step shell (verified in-job — the helper works piped,
the sourced variables never appear). Rotating keys = regenerate
in the Langfuse UI and re-run the installer.

**The env contract.** `startServer` passes EXACTLY seven `LANGFUSE_*`
variables to the spawned server and strips every other `LANGFUSE_*` /
`OTEL_*` variable from the child environment (`TRACING_ENV_KEYS` +
`applyTracingEnv` in `agent/src/stage2/config.ts`, both unit-tested). Do
not add tracing knobs by loosening this — widen the allowlist explicitly or
not at all.

**Degrade behavior — three layers, all deliberate.** Missing helper or
hosted runner → the workflow step sources an empty stream and runs
untraced. Vendored import failure → the loader entry returns a no-op
plugin. Missing credentials → the plugin itself no-ops with a warning. No
layer can fail a review.

**Traps.** The base-URL variable is `LANGFUSE_BASE_URL` (underscore) — the
Langfuse docs page that says `LANGFUSE_BASEURL` is wrong (the plugin
accepts both; we set only the canonical name, and the strip rule removes
the legacy alias). The dev MacBook runs opencode 1.18.x while the pin is
1.17.8: the Langfuse integration tests version-gate and SKIP locally — run
them on the mini (`ssh mini`, PATH needs `~/.bun/bin` and
`/opt/homebrew/bin`). Langfuse v4 has no v3 traces API: read observations
via `GET /api/public/v2/observations` with **Z-suffixed** timestamps — an
unencoded `+00:00` silently returns an empty window (this cost an hour of
misdiagnosis; the traces had been landing all along). Probe evidence and
API notes: `.superpowers/sdd/langfuse-plugin-probe.md` on the mini.

---

## Pinning and upgrading the hub

Pin `uses:` to a **full 40-character commit SHA**, never a tag or branch.
`uses:` accepts no expressions, so this is a real cost: changing the hub means
bumping the SHA in every consumer.

That cost is deliberate. A mutable tag on a public repo executes code on shared
hardware; anyone who can move the tag can run anything on the mini. Note also
that private repos on the Free plan have **no branch protection and no
rulesets**, so nothing reviews a SHA bump — treat it as a trusted operation.

**Do not trust a SHA written in this file.** It lives in the repo whose SHA it
documents, so every commit here invalidates it. Always resolve the current one:

```bash
gh api /repos/pulseai-labs/ci-automation/commits/main --jq .sha
```

To bump a consumer, replace the 40-char SHA on its `uses:` line with that value
and open a PR.

---

## Failure modes and what they mean

| Symptom | Cause |
| --- | --- |
| Job queues forever, never starts | Repo is public, or the runner is offline. Public repos cannot use the runner — check which pattern applies. GitHub cancels queued jobs after 24h. |
| `no curated skill at workspace/.factory/skills/<name>` | The automation was requested but the project has no skill for it. Add the skill or drop it from `automations:`. This is a hard failure on purpose — the alternative is droid running with nothing loaded and reporting confident success. |
| `malformed ref` / `unknown automation` | The input validator rejected hostile or malformed input. Fix the caller; do not weaken the validator. |
| `repository not permitted` from the mint helper | The comment target is not in the helper's allowlist. Add it as root on the runner (Step 5). |
| droid reports "No custom models configured" | `FACTORY_HOME_OVERRIDE` is wrong. It is the HOME directory — the **parent** of `.factory`, not `.factory` itself. |

---

## Making an automation a merge gate

By default an automation is **advisory**: it posts a comment. In Pattern B it
cannot be a status check on its own, because the job runs in the private twin
and its checks appear there, not on the public PR.

To gate merges, add one input:

```yaml
    with:
      automations: qa
      target-repo: pulseai-labs/PulseDB
      target-ref: ${{ inputs.sha }}
      comment-on: pulseai-labs/PulseDB
      comment-issue: ${{ inputs.pr }}
      report-status: true          # <- makes it a gate
```

The hub then posts a commit status to `comment-on` at `target-ref`, with the
context **`droid/<automation>`** — so `droid/qa`, `droid/code-review`,
`droid/security-audit`.

This is generic. It is not specific to PulseDB or to QA: any repo, any
automation, one boolean.

**Add the context to branch protection only after seeing it on a real run.** A
required context that never appears freezes the branch permanently, and
`enforce_admins` makes that unrecoverable without an org owner.

Four properties worth knowing before you turn it on:

- **`pending` is posted before any work**, so the PR shows the gate immediately
  rather than showing a missing check while the single runner drains its queue.
- **The final status is posted under `always()`.** If the job crashes, the gate
  resolves to failure rather than sitting on `pending` forever. A gate that can
  hang is worse than no gate.
- **`INCONCLUSIVE` is a pass.** "No library code changed in this diff" must not
  block a merge. Only an explicit `FAIL` verdict, or a crashed job, fails it.
- **The `droid/` prefix is deliberate.** `Security Audit` already exists as a
  required Actions-pinned context in some repos (cargo-deny). `droid/security-audit`
  cannot collide with it.

Requires `statuses: write` on the worker App and the target repo in the
`status-token` allowlist in `install-mint-helper.sh`.

---

## Traps already hit in production

Each of these cost real debugging time. They are recorded so the next agent does
not rediscover them.

| Symptom | Cause |
| --- | --- |
| `403 Resource not accessible by integration` on dispatch | Used `repository_dispatch` (needs `contents: write`) instead of `workflow_dispatch` (needs `actions: write`). |
| `403` posting a PR comment with `issues: write` | A PR needs `pull_requests: write`. The shared `/issues/{n}/comments` path does not mean shared permissions. |
| `must be set to a non-empty string` from create-github-app-token | The variable or secret is missing, or you referenced the worker names (`PULSEAI_CI_*`) instead of the dispatch names (`PULSEAI_DISPATCH_*`). |
| Hard error requesting `permission-contents` on the dispatch app | It has no `contents` permission at all. Request only what the app holds. |
| Permission added to the App but still 403 | The installation never approved the pending request. |
| `fatal: remote error: upload-pack: not our ref` | Used `github.workflow_sha` (the CALLER's commit) where `github.job_workflow_sha` (this workflow's commit) was needed. |
| Agent behaves like an OLD version despite a new pin | `github.job_workflow_sha` resolves EMPTY for pins to unmerged branch SHAs, and `actions/checkout` then silently falls back to `main` — the workflow FILE comes from your pin, the agent CODE from main. Cost a day of phantom debugging (2026-08-17). Only test with merged-main SHAs. |
| Step fails with a bare exit code and no message | `curl -sf` — `-s` hides the error, `-f` hides the response body. Use `--show-error` and print the HTTP code. |
| `curl` exit 56 mid-run | `CURLE_RECV_ERROR`. The runner is on a weak Wi-Fi link; retry transient failures. |
| droid: "No custom models configured" | `FACTORY_HOME_OVERRIDE` must be the HOME directory, the **parent** of `.factory`. |
| Job queues forever | The repo is public — public repos cannot use the runner. Use Pattern B. |
| PR stuck on a pending `droid/*` check | The job died before its final-status step. It runs under `always()`, so this means the runner itself vanished. Check the daemon. |
| Required check never appears | The context name was guessed. Reusable-workflow job checks are `<caller job> / <called job>`; the commit statuses this hub posts are `droid/<automation>`. Read one from a real run first. |

---

## Rules for agents working in this repo

- **Never** add a secret to this repository. It is public and consumed by
  fourteen repos.
- **Never** interpolate `inputs.*`, `github.event.*`, or `client_payload.*`
  directly into a `run:` block. Use `env:` and reference `"$VAR"`.
- **Never** relax `persist-credentials: false`. Unsetting `GITHUB_TOKEN` from
  the environment does not remove a token already written to disk.
- **Never** grant an automation write autonomy to "make it work". Autonomy is
  set centrally per automation so it cannot drift per-repo.
- **Never** add a public repository to the runner group, or set
  `allows_public_repositories: true`. That is the one control protecting the
  hardware.
- Before registering anything on the runner, run
  `scripts/verify-runner-scope.sh` in `draco-hub-macos-server`. It fails closed.
