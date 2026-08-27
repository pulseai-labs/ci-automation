# ADR-0003: No Ansible — shell scripts are the configuration plane

- Status: Accepted
- Date: 2026-08-03
- Supersedes: `docs/server-spec.md` "Ansible is the default desired-state mechanism"

## Context

`docs/server-spec.md` named Ansible as the desired-state mechanism, and an
`ansible/` tree was scaffolded: one 26-line role asserting macOS and printing
facts. Ansible was never installed, the inventory was `ansible_connection:
local`, and no host state was ever managed by it.

Meanwhile the build produced **thirteen idempotent, tracked, self-testing
scripts** covering power, the runner identity, droid configuration, the runner
install/register/service cycle, both App credentials, the mint helper, the
gh token, the heartbeat, and verification.

## Decision

**Do not adopt Ansible. The scripts are the configuration plane.**

### Why

1. **It is redundant.** Ansible's value here would be idempotency, drift
   detection, and remote execution. The scripts are already idempotent, and
   `scripts/check-host.sh` is the drift detector — arguably a better one,
   because it asserts *behaviour* ("can `github-runner` execute droid?", "can it
   read the App key?") rather than file state. An Ansible dry-run cannot answer
   either question.

2. **The roadmap already supersedes it.** `HOMELAB_PAAS_SPEC` decision D1 puts
   `pulsed` — a Rust reconciler rendering launchd plists and systemd units — at
   the centre of the fleet. Building an Ansible layer now means building
   something already specified for replacement, then migrating off it.

3. **It worsens the rebuild story.** The stated target is "macOS + this
   repository + external secrets". Ansible makes that "macOS + this repository +
   Python + Ansible + collections". For a single host that is a regression in
   the property the spec cares most about.

4. **A stub is worse than nothing.** An `ansible/` tree that manages no state
   implies a plan nobody is executing. Twice today, documentation that described
   an intention rather than reality sent work in the wrong direction.

### What replaced it

| Ansible would have provided | Provided instead |
| --- | --- |
| Idempotent host changes | the thirteen `scripts/*.sh`, each safe to re-run |
| Desired-state assertion | `scripts/check-host.sh` — behavioural, not declarative |
| Ordering / dependencies | `scripts/bootstrap.sh` — plan and run, with human-gated steps marked |
| Config under version control | `config/sshd-050-draco-hardening.conf` — the last untracked host config |

### The gap this closed

The SSH policy — key-only, no root, no passwords — existed **only** in the
gitignored `local/` directory. A rebuild from this repository would have
produced a CI runner with default SSH. It is now `config/` plus
`scripts/harden-sshd.sh`, which validates the effective merged policy with
`sshd -T`, rolls back on failure, and deliberately does not restart sshd so
existing sessions survive a mistake.

## Consequences

- The rebuild path is `git clone` then `./scripts/bootstrap.sh`. No package
  manager, no runtime, no collections.
- Multi-host management is unsolved, deliberately. Revisit only if `pulsed`
  slips **and** there are three hosts to manage. Ansible would be a reasonable
  answer to that problem; it was not an answer to this one.
- `docs/server-spec.md` is corrected accordingly.
