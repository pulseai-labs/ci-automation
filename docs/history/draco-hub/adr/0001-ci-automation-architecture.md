# ADR-0001: CI automation architecture for droid-driven pipelines

- Status: Accepted
- Date: 2026-08-03
- Deciders: Draco (org owner, `pulseai-labs`)
- Supersedes: the runner-topology paragraphs of `docs/server-spec.md` where they conflict

## Context

The Mac mini is being converted into headless CI infrastructure. The intended
workload is a family of Factory `droid` headless automations — QA today, code
review and security audit next — driven by **project-scoped** Factory skills and
a **BYOK custom model** (`glm-5.2` via the Z.AI coding plan), reused across the
`pulseai-labs` organisation's 14 repositories.

The operator asked why this should not be built as a GitHub App in the style of
CodeRabbit or Codex, installed once and reused everywhere.

Binding constraints:

- `AGENTS.md` and `docs/server-spec.md` forbid public inbound administration.
  There is no port forwarding, no DMZ, no tunnel; Tailscale Funnel was not
  granted.
- The org is on the GitHub **Free** plan: 10 private repos, 4 public.
- droid authenticates via a **login session**, not a Factory subscription API
  key. Inference goes direct to Z.AI.
- The runner must run as a non-admin account, not as `draco`.

## Decision

Build a **reusable-workflow platform on a self-hosted runner**, scoped by a
runner group. Do **not** build a GitHub App now.

### 0. AMENDMENT 2026-08-03 — the App is foundational, not deferred

The original §1 below deferred the GitHub App on the grounds that its only job
was cross-repo read, which a deploy key could do more cheaply. That reasoning
was correct in isolation and **wrong against the operator's actual onboarding
model**, which is: add a pipeline to each new project, repeatedly, over SSH.

A deploy key is scoped to **one repository, by definition** — there is no
org-wide deploy key. So every new project would require: SSH to the mini,
generate a keypair, upload the public key, edit `~/.ssh/config`. Forever.

An App installed org-wide does not. Verified live on this org — three Apps are
already installed this way:

```text
chatgpt-codex-connector   repository_selection=all
devin-ai-integration      repository_selection=all
factory-droid             repository_selection=all
```

`repository_selection=all` means **every future repository is covered with no
further action**. That is the property the onboarding model needs, and only the
App has it.

Revised decision:

- **Register the GitHub App now**, webhooks unchecked, installed org-wide with
  "All repositories", permissions `Metadata: read` + `Contents: read` +
  `Issues: write`.
- **The deploy key is demoted to a fallback**, retained in
  `scripts/setup-github-runner.sh` for single-repo cases but no longer the
  primary credential path.
- Per-project onboarding is then: push a caller workflow, push curated skills.
  Both are `git push` from the MacBook. **Neither touches the mini.**

**Live values are NOT recorded here.** Run:

```bash
./scripts/context.sh apps
```

App IDs, installation IDs and granted permissions all change, and a value
written into a document is wrong from the moment it changes. This section
previously listed the worker app as holding
`{"contents":"read","issues":"write","metadata":"read"}` — accurate when
written and stale within a day, once `actions:write`, `pull_requests:write` and
`statuses:write` were added. That is the failure mode this whole project kept
producing, so the values are gone and the command stays.

What does not drift, and is therefore worth writing down: the worker key lives
only at `/usr/local/etc/pulseai-ci/app.pem`, `root:wheel 0400`, and never enters
GitHub. The dispatch key is the one credential in a public repo and can trigger
a single workflow in a single private repo. `scripts/install-app-key.sh` proves
the chain rather than assuming it — PEM validated, RS256 JWT accepted, a real
token minted, permissions read back, then revoked.

**Permission note — corrected 2026-08-03 by a live failure.** An earlier
version of this ADR claimed `issues: write` covers PR conversation comments,
on the reasoning that "PR comments are issue comments in the API". That is
wrong. The first end-to-end run posted to
`POST /repos/{owner}/{repo}/issues/67/comments` with a token holding
`issues: write` and received:

```text
HTTP 403 {"message": "Resource not accessible by integration"}
```

GitHub's permission check is **resource-based, not endpoint-based**: the API
path is shared between issues and pull requests, but commenting on a pull
request requires `pull_requests: write`. The docs list that endpoint under both
permissions, which is what made the wrong reading plausible.

The App therefore holds `issues: write` **and** `pull_requests: write`, and
`comment-token` requests both. Inline review comments on the diff use a
different endpoint and are also covered by `pull_requests: write`.

General lesson worth keeping: requesting a permission the installation lacks is
a hard error at mint time, never a silent downgrade — so these mistakes surface
as clean 403s rather than as over-broad access. Widening requires org-owner
approval of the pending request on the installation; editing the App alone does
not grant it.

### 1. No GitHub App in phase one *(superseded by §0)*

A GitHub App is an identity and authorization object — App ID, RSA key,
permission set, optional webhook subscription, one installation record per
account. It supplies **zero compute, zero hosting, zero runner**.

What makes CodeRabbit feel like "install once, works everywhere" is not the App.
It is the always-on public HTTPS webhook receiver the vendor hosts. Greptile
publishes the bill of materials for that half: webhook receiver, orchestrator,
message queue, chunker/summarizer/review workers, an LLM proxy, and
Postgres+pgvector. That service is precisely what our no-public-inbound rule
forbids, and `gh webhook forward` is not an escape hatch — it does not support
App webhooks and is documented as unsuitable for production.

The App-without-webhooks pattern is legitimate and vendor-documented (Anthropic:
*"Webhooks: Uncheck 'Active' (not needed for this integration)"*), with
`actions/create-github-app-token` minting scoped installation tokens inside
workflows. We may adopt it later. We are not adopting it now, because in this
design the App's only unique function is **cross-repo `contents:read`** on
`pulsedb-internal`, and a read-only deploy key or fine-grained PAT on disk
delivers that with no App registration, no JWT chain, no root mint helper, and
no PEM rotation runbook.

**The reusable workflow is the reuse primitive. The App is a credential-broker
upgrade, deferred to a later phase.**

Deferred benefits we knowingly forgo for now: a bot identity on PR comments, and
a rate-limit bucket separate from `draco28`'s personal 5,000 req/hr.

### 2. Actions is the trigger plane; the mini is only compute

GitHub Actions already is a webhook receiver, job queue and state machine. The
self-hosted runner protocol is an outbound HTTPS long poll — a NAT-traversing
reverse tunnel that needs no inbound connection. Every leg is outbound: runner
poll, token mint, git clone, and droid inference to Z.AI.

This satisfies "no public inbound administration" without a tunnel, without
Funnel, and without any change to `tailscale/policy.json`.

Offline behaviour favours this strongly: Actions **queues a job for 24 hours**
and then cancels it — graceful degradation, no operator action. A webhook
delivery to a down receiver is simply **lost**, recoverable only by a script
running on the machine that was down.

### 3. Runner scoping is the security control — not workflow-level gates

**This is the most important decision in this ADR.**

For a `pull_request` event the workflow file that executes comes from the PR's
merge commit. A fork PR can therefore supply its **own** workflow:

```yaml
on: pull_request
jobs:
  x:
    runs-on: [self-hosted, macOS, ARM64]
    steps: [{run: "cat ~/.factory-ci/* ~/actions-runner/.credentials; curl ..."}]
```

Our caller file, the hub's fork gate, the SHA pin, the environment scrub — none
of it is on that code path, because the attacker never calls our hub. Any design
whose public-repo defence is "our workflows run elsewhere" is defending the
wrong control.

The real control is the **runner group**:

- Runner groups **are available on the Free plan** (GitHub changelog,
  2024-10-17: *"organizations on all plans, including the Free plan, can now
  utilize GitHub Actions runner groups with self-hosted runners"*). Only
  GitHub-hosted *larger* runners are excluded. `docs.github.com` body text still
  claims Team-only; it is stale.
- *"By default, only private repositories can access runners in a runner
  group."* — the default is already correct, and must be verified rather than
  assumed.

Therefore: **one org-level runner, in a group with
`allows_public_repositories: false`.** This makes `docs/server-spec.md`'s *"no
public repository access to the persistent runner"* true by configuration
rather than by convention.

**API behaviour verified 2026-08-03 — `visibility: "private"` is silently
coerced to `"all"`.** It is neither honoured nor rejected; a create or patch
returns `200` with `visibility: "all"`. Only `all` and `selected` persist. So
the intended "every private repo, no public repo" state must be expressed as:

```text
visibility = all   +   allows_public_repositories = false
```

`allows_public_repositories` is the field doing the work, per GitHub's own
docs: *"By default, only private repositories can access runners in a runner
group."* `visibility` only narrows further.

`selected` was the original choice here, but its allowlist must be edited for
every new project — the exact onboarding friction §0 removes. `all` +
`allows_public_repositories: false` gives identical protection against the
attack that matters (a fork PR naming `runs-on: [self-hosted, ...]`) with zero
per-project work. The deliberate loosening: any future **private** repo can use
the runner without being opted in.

Live state (`scripts/create-runner-group.sh --apply`, 2026-08-03):

```text
id=3  mac-mini-private  visibility=all  allows_public_repositories=false
```

Because the coercion is silent, `create-runner-group.sh` now compares the
requested visibility against what the API stored and refuses to report success
on a mismatch — and refuses a `selected` group with zero repositories, which
would leave the runner unusable rather than exposed.

Per `AGENTS.md`, scope must be **confirmed before registration**, not after.
`scripts/verify-runner-scope.sh` is that gate and must pass first.

Fork-PR approval settings are explicitly **not** counted as a layer: the default
is *"first-time contributors"*, so one merged trivial PR grants an attacker
permanent auto-approval.

### 4. Three layers of reuse, with different scopes

| Layer | Scope | Lives in | Reuse mechanism |
| --- | --- | --- | --- |
| Skills (QA, code review, audit) | **Per project**, curated | that project's AI-workspace repo, `.factory/skills/` | deliberately not reused |
| droid config (model, autonomy, log caps) | Org-wide | runner-side settings; later `FACTORY_ORG_MANAGED_SETTINGS_URL` | one central source |
| Orchestration (checkout, run, report) | Org-wide | **public** `pulseai-labs/ci-automation` | reusable workflow (`workflow_call`) |

The hub repository **must be public**. A public repository can only consume
reusable workflows and actions from public repositories, and no Access setting
on a private repo overrides this. PulseDB is public and `pulsedb-internal` is
private, so the intuitive "shared workflow next to the skills" design cannot
resolve. The orchestration carries no secrets, so publishing it is free.

It must be a **reusable workflow**, not a composite action: only `workflow_call`
can centralise `runs-on`, and runner selection is exactly what we need in one
place.

### 5. Per-repo onboarding

`.github/workflows/droid.yml`, identical in every repo:

```yaml
name: Droid Automations
on:
  pull_request:
    branches: [main]
  workflow_dispatch:
jobs:
  droid:
    uses: pulseai-labs/ci-automation/.github/workflows/droid.yml@<sha>
    with:
      automations: qa
```

Adding an automation later: `automations: qa,code-review,security-audit`.

Honest cost, stated because the alternative framing is misleading: SHA-pinning
means a hub change is one hub edit **plus a SHA bump in every consuming repo**.
"One edit" and "SHA-pinned" cannot both be true. We choose pinning and accept
the bump, scripted. Private repos on Free have neither branch protection nor
rulesets, so nothing gates that bump — it must be treated as a trusted operation.

## Consequences

### Accepted costs

- Per-repo cost is ~8 lines of YAML, not zero. Zero requires the webhook
  receiver we cannot host.
- **Automation output on the 10 private repos is advisory forever.** Branch
  protection and rulesets are unavailable on Free for private repos (verified:
  `GET /repos/.../rulesets` → 403 *"Upgrade to GitHub Pro or make this
  repository public"*). No policy can require anyone to read a droid comment
  there. GitHub Team is ~$4/seat/month and should be priced before this platform
  is extended.
- Capacity is a real limit. One runner, three automations, 14 repos and ~18
  minute jobs is roughly an hour of serialized mini time per PR. A `concurrency`
  group with `cancel-in-progress` is mandatory in the hub, not optional.

### Explicit non-goals

- No webhook receiver, queue, database, or always-on service beyond the runner.
- No inbound port, public hostname, or tunnel.
- No App-authored check runs. `GITHUB_TOKEN` is already an App installation
  token (`app_id: 15368`) and can create check runs with `checks: write`. A
  custom App posting a same-named check would **not** satisfy PulseDB's 13
  Actions-pinned required contexts, and `enforce_admins: true` means nobody
  could merge around the mistake.

### Known landmines recorded here so they are not rediscovered

- `Security Audit` is **already** a required, Actions-pinned context on PulseDB
  `main`, emitted by `cargo-deny` in `ci.yml`. The droid audit job must not use
  that name.
- A reusable workflow reports its check as `<caller job> / <called job>`.
  Guessing that string and adding it to required checks freezes `main`. Record
  the emitted context off a real run first.
- A **job** skipped by `if:` reports Success and does not block. A **workflow**
  skipped by path/branch filtering leaves its check Pending forever and blocks
  the merge. This asymmetry is what froze `main`.
- `actions/checkout` defaults `persist-credentials: true`; the token lands on
  disk readable by the runner uid. Scrubbing environment variables does not
  remove it. Set `persist-credentials: false` in the hub.
- `secrets: inherit` passes **all** caller secrets to the callee. The hub is
  public. Pass secrets by name.

## Open items

### 1. droid headless — RESOLVED 2026-08-03

Verified by `scripts/setup-github-runner.sh test`, which bootstraps a transient
LaunchDaemon running as the non-admin runner account:

```text
whoami=github-runner uid=502 gid=401
security-session=System
KEYCHAIN=unreachable
FACTORY_HOME_OVERRIDE=/Users/github-runner
-- model resolution (rc=0) --   Available tools for glm-5.2
-- inference (rc=0) --          HEADLESS_OK
```

droid authenticates and runs real inference against the BYOK GLM-5.2 model
under a root LaunchDaemon with no GUI session and no login keychain. The
non-admin LaunchDaemon design holds. **No Factory subscription, no
`FACTORY_API_KEY`, and no auto-login are required** — so ADR-0002 stands
unchanged and the FileVault posture is preserved.

Two conditions are load-bearing and must be reproduced on any rebuild:

- **`FACTORY_DISABLE_KEYRING=1` must be set at LOGIN time**, not only at run
  time. It selects the storage backend: with it, droid v2 writes
  `auth.v2.file` + `auth.v2.key` (plain files, 0600, readable by a daemon);
  without it, `auth.v2.loginkeychain`, which a LaunchDaemon can never unlock.
- **`FACTORY_HOME_OVERRIDE` is the HOME directory, the parent of `.factory`** —
  not the `.factory` directory. Pointing it at `.factory` makes droid search
  `.factory/.factory` and report "No custom models configured", which reads
  like a broken install and is not.

### 2. Git credentials depend on an unlocked login keychain — OPEN

`gh` stores its token in the macOS login keychain, and git is configured to use
`gh auth git-credential`. That works only while someone is logged in at the
console: from an SSH session the helper cannot read the keyring, git falls
through to `osxkeychain`, and prompts for a password that cannot succeed
(GitHub disabled password auth for HTTPS git in 2021).

This is not a papercut. It surfaced three times in one session, each time
looking like a different problem:

1. `git pull` prompting for a password that cannot work
2. `gh api` returning `401 Requires authentication` in an SSH session, while
   the identical call succeeded from the console
3. droid — already solved, by `FACTORY_DISABLE_KEYRING=1`

One root cause: **the login keychain is bound to a console session, and this
machine is administered over SSH and is becoming a server nobody logs into.**
A credential the server cannot read is not a security control; it is an outage.

Resolution (`scripts/setup-gh-token.sh`): write the token to
`~/.config/gh/token.env`, mode `0600`, and export `GH_TOKEN` from `~/.zshrc`.
`gh` prefers `GH_TOKEN` and skips the keyring entirely, so it behaves
identically from SSH, the console, and launchd. The script reads the value via
`gh auth token` and never prints it.

Accepted trade: a long-lived token in a file is strictly weaker than the
keychain. It is `0600` on FileVault-protected internal storage, and rotation is
`gh auth refresh && ./scripts/setup-gh-token.sh`.

Note that §0 removes the *other* reason this mattered — the runner no longer
needs a per-repo deploy key, so this is now purely about administration.

### 3. Still open

- FileVault reboot recovery (ADR-0002) gates unattended operation: a root
  LaunchDaemon cannot start before volume unlock, and queued jobs cancel after
  24 hours.
- Tailscale node key expires **2026-10-27**. CI survives it; SSH does not.

## References

- GitHub changelog, runner groups on Free — 2024-10-17
- GitHub docs, managing access to self-hosted runner groups
- GitHub Security Lab, "Preventing pwn requests"
- GitHub docs, reusing workflow configurations (public/private access matrix)
- Anthropic, Claude Code GitHub Actions custom App setup
- Greptile, self-hosted system architecture
- `docs/audit-2026-08-02.md` — the audit this ADR responds to
