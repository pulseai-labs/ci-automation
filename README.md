# ci-automation

Shared GitHub Actions orchestration for droid-driven automations across
`pulseai-labs` — QA, code review, and security audit.

**This repository is public by necessity.** A public repository can only consume
reusable workflows from public repositories, and no Access setting on a private
repository overrides that. Since some callers are public, the hub must be too.

It contains **no secrets**. Credentials are minted on the runner from a
root-owned GitHub App key that the runner itself cannot read.

## Onboarding a project

**Read [AGENTS.md](AGENTS.md)** — it covers the single-repo pattern, the
dual-repo pattern for public projects, what is automatic for new repos, and the
exact per-project cost. Written for an agent working without prior context.

## Using it

Add one file to a repository:

```yaml
# .github/workflows/droid.yml
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

Adding more later is one edit: `automations: qa,code-review,security-audit`.

Pin to a full commit SHA, not a tag. `uses:` accepts no expressions, so a hub
change means bumping the SHA in each consumer — that cost is real and is the
deliberate trade for not having a mutable tag execute code on shared hardware.

## What lives where

| Layer | Scope | Where |
| --- | --- | --- |
| Skills | **Per project**, curated | that project's `.factory/skills/` |
| Orchestration | Org-wide | this repository |
| droid config, model, autonomy | Org-wide | the runner, and this workflow |

Skills are deliberately **not** shared. Each project curates its own; the
workflow fails with a clear message if the skill for a requested automation is
missing, rather than running droid with nothing loaded and reporting success.

## Security posture

- Every input is validated on a hosted runner **before** the self-hosted runner
  is involved, and before any untrusted content is checked out. Fails closed.
- Inputs never reach `run:` directly — they pass through `env:`. Refs are
  pattern-validated because they become checkout targets.
- `persist-credentials: false` on every checkout: unsetting `GITHUB_TOKEN` from
  the environment does not remove a token written to disk.
- droid runs with no GitHub credential in its environment at all.
- Cross-repo writes use a single-purpose token minted by a root helper that
  accepts no permission arguments, then revoked.
- The workspace is wiped after every job; `_work` is not cleaned between runs.

Architecture and rationale: `pulseai-labs/draco-hub-macos-server`, `docs/adr/`.
