# History — where ci-automation's documentation came from

This repo's specs, plans, and architecture records were originally written in
`draco-hub-macos-server` (private) and as gitignored scratch on the Mac mini.
Copies live here so any session working from this public checkout has the full
design history without needing other repositories or machines.

Copied 2026-08-27. The copies are snapshots: treat the source repos as the
live version if they disagree with these files.

| Path | Origin | What it is |
| --- | --- | --- |
| `draco-hub/specs/2026-08-05-custom-ci-review-agent-design.md` | draco-hub-macos-server `docs/superpowers/specs/` | Design spec for the custom review agent (code-review) |
| `draco-hub/specs/2026-08-05-step0-droid-baseline.md` | draco-hub-macos-server `docs/superpowers/specs/` | Step 0 baseline: droid automations before the custom agent |
| `draco-hub/plans/2026-08-05-custom-ci-review-agent.md` | draco-hub-macos-server `docs/superpowers/plans/` | Full implementation plan for the review agent |
| `draco-hub/adr/0001-ci-automation-architecture.md` | draco-hub-macos-server `docs/adr/` | Runner group security model, Pattern A/B, two-app split |
| `draco-hub/adr/0002-reboot-and-recovery-model.md` | draco-hub-macos-server `docs/adr/` | Mini reboot/recovery decisions |
| `draco-hub/adr/0003-no-ansible.md` | draco-hub-macos-server `docs/adr/` | Why configuration management stays manual |
| `draco-hub/bootstrap-runbook.md` | draco-hub-macos-server `docs/` | Mac mini setup runbook (runner, apps, paths) |
| `draco-hub/server-spec.md` | draco-hub-macos-server `docs/` | Hub server spec |
| `draco-hub/acceptance.md` | draco-hub-macos-server `docs/` | Acceptance evidence for the original build |

Two empirical probe documents could not be copied yet: they exist only as
gitignored scratch under `/Users/draco/projects/ci-automation/.superpowers/sdd/`
on the mini (`opencode-tool-discovery.md`, `langfuse-plugin-probe.md`), and
the volume holding that path was unreadable on 2026-08-27 (see
`../operating-model.md`). Key conclusions from both survive in this repo's
AGENTS.md traps sections and in `.superpowers/`-era session reports; retry the
copy when the volume is back.
