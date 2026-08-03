# AGENTS.md — onboarding a project to droid CI

How to add a droid automation pipeline (QA, code review, security audit) to a
project in `pulseai-labs`. Written for an agent or operator doing this without
prior context.

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
| **GitHub App `pulseai-ci`** | Installed org-wide with `repository_selection: all`. Every repo created in the org from now on is covered the moment it exists. There is nothing to install, authorise, or configure for a new project. |
| **Runner group membership** | `mac-mini-private` is `visibility: all` + `allows_public_repositories: false`, so every **private** repo — including ones created tomorrow — can already use the runner. No allowlist to edit. |
| **Runner credentials** | The App key lives root-owned on the runner. Jobs mint 1-hour scoped tokens through a root helper. No repo secret, no deploy key, no PAT anywhere. |
| **droid model + auth** | Configured once for the `github-runner` account on the mini. |

**If you find yourself creating a deploy key, adding a repo secret, or editing
the runner group for a new project, stop — you are working against the design.**
The only legitimate exceptions are listed under "Genuine per-project friction".

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
  on: pull_request                    on: repository_dispatch
  runs-on: ubuntu-latest      ──────► runs-on: self-hosted
  mints App token, dispatches         calls the hub, checks out PulseDB
                                      at the dispatched SHA, comments back
```

**Step 1.** Put the skills in the **private** repo: `.factory/skills/qa/…`

**Step 2.** In the **private** repo, `.github/workflows/droid.yml`:

```yaml
name: Droid Automations
on:
  repository_dispatch:
    types: [droid-qa]
  workflow_dispatch:
jobs:
  droid:
    uses: pulseai-labs/ci-automation/.github/workflows/droid.yml@<40-char-sha>
    with:
      automations: qa
      target-repo: pulseai-labs/PulseDB
      target-ref: ${{ github.event.client_payload.sha }}
      comment-on: pulseai-labs/PulseDB
      comment-issue: ${{ github.event.client_payload.pr }}
```

The hub validates `target-ref` and `comment-issue` on a hosted runner before the
mini is touched, so a malformed or hostile `client_payload` fails closed. Do not
add your own interpolation of `client_payload` into a `run:` block.

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
          app-id: ${{ vars.PULSEAI_CI_APP_ID }}
          private-key: ${{ secrets.PULSEAI_CI_PRIVATE_KEY }}
          owner: pulseai-labs
          repositories: pulsedb-internal
      - env:
          GH_TOKEN: ${{ steps.token.outputs.token }}
          SHA: ${{ github.event.pull_request.head.sha }}
          PR: ${{ github.event.pull_request.number }}
        run: |
          gh api -X POST /repos/pulseai-labs/pulsedb-internal/dispatches \
            -f event_type=droid-qa \
            -F "client_payload[sha]=$SHA" \
            -F "client_payload[pr]=$PR"
```

**Step 4 — the one real per-project cost.** The public repo needs
`PULSEAI_CI_APP_ID` (a *variable*) and `PULSEAI_CI_PRIVATE_KEY` (a *secret*),
because a GitHub-hosted runner cannot read the key on the mini.

This is a deliberate, bounded exception to "no secrets in repos". It applies
**only to public repos in Pattern B**, and only to the trigger. Fork PRs never
receive it. Set it with:

```bash
gh variable set PULSEAI_CI_APP_ID --repo pulseai-labs/PulseDB --body 4470964
gh secret set PULSEAI_CI_PRIVATE_KEY --repo pulseai-labs/PulseDB < /path/to/app.pem
```

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
4. **Pattern B only:** the App ID variable + private key secret on the public
   repo, and the mint-helper allowlist entry.

---

## Pinning and upgrading the hub

Pin `uses:` to a **full 40-character commit SHA**, never a tag or branch.
`uses:` accepts no expressions, so this is a real cost: changing the hub means
bumping the SHA in every consumer.

That cost is deliberate. A mutable tag on a public repo executes code on shared
hardware; anyone who can move the tag can run anything on the mini. Note also
that private repos on the Free plan have **no branch protection and no
rulesets**, so nothing reviews a SHA bump — treat it as a trusted operation.

Current: `9719dad8a3f2edef6c42faa6e1996a11d55e7743`

To bump everywhere:

```bash
NEW=$(gh api /repos/pulseai-labs/ci-automation/commits/main --jq .sha)
# then update each consumer's uses: line and open a PR per repo
```

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
