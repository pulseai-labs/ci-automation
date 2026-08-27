# Mac mini CI server specification

## Purpose

The Mac mini is dedicated build infrastructure for trusted GitHub projects. It
provides persistent Apple hardware, toolchain caches, Xcode/macOS execution,
and release capabilities that should not run on the daily-use MacBook.

This repository must be sufficient to understand, reproduce, verify, and
recover the server without relying on an agent's conversation history.

## Architecture

### Administration plane

- Tailscale supplies private network reachability and device-level policy.
- Native macOS Remote Login supplies OpenSSH on the mini.
- SSH public-key authentication is the normal shell path.
- macOS Screen Sharing over Tailscale is the recovery path for GUI-only tasks.
- No administration port is exposed through router forwarding, a public tunnel,
  or a public IP address.

### Configuration plane

- This private Git repository is the source of truth.
- Initial execution is local on the Mac mini after cloning the repository.
- Idempotent shell scripts under `scripts/` are the desired-state mechanism.
  Ansible was evaluated and rejected — see `docs/adr/0003-no-ansible.md`. In
  short: the scripts are already idempotent, `scripts/check-host.sh` is a better
  drift detector because it asserts behaviour rather than file state, and the
  `HOMELAB_PAAS_SPEC` roadmap already specifies `pulsed` as the fleet
  reconciler.
- `scripts/bootstrap.sh` sequences them and marks the steps that require a
  human — a browser flow, an interactive login, or a password.
- Host configuration that is not generated lives in `config/` and is applied by
  a script that validates before installing.

### CI execution plane

- GitHub's runner process makes outbound HTTPS connections to GitHub.
- The runner uses a dedicated non-admin macOS account.
- Persistent runners receive trusted jobs only.
- GitHub-hosted runners remain available for untrusted pull requests and Linux
  container workloads.
- Runner labels must express capabilities, not project names. Expected examples
  are `mac-mini`, `apple-silicon`, `xcode`, and `signing` where applicable.

## Locked decisions

| Area | Decision |
| --- | --- |
| Repository | Dedicated private `draco-hub-macos-server` repository |
| Network | Tailscale only; no public inbound administration |
| Shell access | Native macOS OpenSSH over the tailnet |
| Tailscale variant | Keep the standard macOS client initially |
| GUI recovery | Apple Screen Sharing restricted to authorized users |
| Runner identity | Dedicated non-admin local account |
| Provisioning | Idempotent shell scripts; see ADR-0003 (Ansible rejected) |
| Secrets | Just-in-time or external password manager; never Git |
| Trust | Persistent runner handles trusted workflow code only |
| Linux containers | Stay on GitHub-hosted Linux or a separate Linux runner |
| Public automation | Separate GitHub App agent service; no public repository access to the persistent runner |

## Resolved live facts (2026-08-02)

### Host and storage

- The host is an Apple-silicon `Macmini9,1` (Apple M1) with 16 GiB RAM,
  running macOS 26.5.1 (build 25F80).
- `ComputerName`, `LocalHostName`, `HostName`, and the kernel hostname are all
  `dracos-mac-mini`.
- The internal 228 GiB APFS container has approximately 104 GiB available
  after removing stale workstation and runner state.
- The permanently connected `master_ssd` is a 1 TB APFS SSD with approximately
  337 GiB available. It is not encrypted. Existing project directories are
  administrator-owned but currently readable by other local users; they must
  not be exposed to the future runner account.

### Administration and security

- `draco` is the only regular local account and the only regular member of the
  administrator group. The proposed `github-runner` account does not exist.
- FileVault, Gatekeeper assessments, and System Integrity Protection are on.
  MDM enrollment and automatic login are absent.
- The macOS application firewall is off. Enabling and verifying it remains a
  Phase 1 baseline change.
- Native Remote Login is on. Access is limited by macOS's SSH service ACL to
  administrators; the future non-admin runner will not receive shell access.
- SSH uses a dedicated MacBook ED25519 key. A root-owned
  `/etc/ssh/sshd_config.d/050-draco-hardening.conf` requires public-key
  authentication, disables password and keyboard-interactive authentication,
  and prohibits root login. Multiple fresh direct and alias sessions passed.
  This live bootstrap state still needs configuration-as-code coverage.
- Native macOS Screen Sharing is on and restricted by the
  `com.apple.access_screensharing` service ACL to the local administrator
  group. A fresh MacBook connection through the Tailscale MagicDNS name was
  accepted for both viewing and control. Remote Management remains off.

### Tailscale and power

- Tailscale 1.98.10 is the signed Standalone macOS application
  (`io.tailscale.ipn.macsys`). After the approved reboot test, the live device
  name is `dracos-mac-mini-1` and the corresponding MagicDNS name is
  `dracos-mac-mini-1.tail71316d.ts.net`. The earlier unsuffixed MagicDNS name
  no longer resolves from the mini; the MacBook SSH alias must be revalidated
  against this live identity before it is treated as a recovery path.
- The live tailnet policy is tracked in `tailscale/policy.json`: only the
  MacBook may initiate TCP 22 and TCP 5900 connections to the running mini,
  and only the MacBook may initiate TCP 22 to the mini's reserved preboot
  address. The other three current devices retain their existing mutual
  connectivity. Tailscale SSH and Funnel capabilities are not granted.
  Tailscale accepted the embedded tests protecting both administrative
  allowlists and corresponding denials before publishing the policy.
- Both the MacBook and mini are owned by the same tailnet identity, have no
  advertised subnet routes, cannot act as exit nodes, use encrypted Tailscale
  state, and are on the stable auto-update track. The mini's node key currently
  expires in approximately three months.
- Public exposure was externally tested for native SSH TCP 22 and Screen
  Sharing TCP 5900 over both the current public IPv4 and the mini's global
  IPv6 address. An independent 18-node service reported zero successful
  handshakes for either port on IPv4 and IPv6. Six of those workers succeeded
  against a known public IPv6 HTTPS control, confirming usable IPv6 vantage
  points. A separate service reported TCP 22 closed from all five workers; its
  first TCP 5900 run produced one success among five workers, but that result
  was not reproduced by any of 10 immediate repeat workers or the 18-node
  independent run and produced no corresponding local Screen Sharing event.
  Tailscale also reports no UPnP, PCP, or NAT-PMP capability. Current evidence
  therefore supports no router/public exposure, while the macOS application
  firewall remains a separate required baseline improvement.
- The live AC-power baseline sets system sleep to never (`sleep=0`), keeps
  wake-on-network enabled (`womp=1`), and enables restart after an unexpected
  power loss (`autorestart=1`). `autorestartatconnect` remains off so an
  intentional shutdown is preserved. Display sleep and unrelated power
  settings remain unchanged. `scripts/configure-power.sh` applies and verifies
  only these server-critical values.
- An explicitly approved reboot test was performed with the MacBook on the
  same LAN and physical fallback available. Neither the Tailscale address nor
  the mini's prior runtime Wi-Fi address accepted the temporary FileVault
  password SSH connection. The mini became reachable only after the operator
  entered the FileVault password at its attached monitor. After that unlock, a
  fresh non-multiplexed MacBook connection to the new suffixed MagicDNS name
  succeeded with the unchanged host key and reported the expected local user
  and hostname.
- The preboot SSH facility itself was provisioned: its enablement plist is
  true, preboot host keys exist, and its ED25519 fingerprint matches the normal
  host. Boot evidence shows the standard Tailscale application starting only
  after physical FileVault unlock. The failed result is therefore a preboot
  network-reachability failure, not evidence that FileVault SSH was disabled.
  The mini is not yet remotely recoverable from a FileVault-locked reboot.
- The mini cannot be physically connected to the router and must remain on
  Wi-Fi. Its normal Wi-Fi session uses a private MAC address that differs from
  the hardware address represented in the APFS Preboot network configuration.
  Router DHCP logs prove that both FileVault-locked boots nevertheless used
  the private identity and received `192.168.1.3`, at 16:56 and 20:02
  respectively.
- The router's Static DHCP feature is enabled and now reserves
  `192.168.1.250` for the observed private Wi-Fi identity. The earlier
  hardware-identity reservation was replaced and applied after live DHCP
  evidence showed it was never used. The unlocked mini renewed its `en1` lease
  successfully, obtained only `192.168.1.250`, retained gateway
  `192.168.1.1`, accepted native SSH on TCP 22, and remained connected to
  Tailscale. No port forwarding, DMZ, DNS, Wi-Fi, firewall, or general LAN
  addressing setting was changed.
- The existing always-on `draco-hub` Linux node is on the same local network
  and advertises exactly the reserved `192.168.1.250/32` route; the tailnet
  route is approved. The live policy permits only the MacBook to reach TCP 22
  on that routed address and explicitly tests the corresponding denials. The
  private-MAC runtime and Preboot identities now share the reserved address
  because live evidence showed both use the same identity. No general LAN
  route, exit-node capability, router port
  forwarding, or broader preboot grant was enabled. A second explicitly
  approved test placed the MacBook off-LAN and polled TCP 22 on the routed
  address continuously from 20:01 through 20:07; the port never opened and
  physical FileVault unlock was again required. The configured recovery path
  is therefore failed, not merely untested. After unlock, a temporary
  `192.168.1.250` alias on the running mini accepted TCP 22 and native key-only
  SSH from the off-LAN MacBook through the same `/32` route. This proves the
  `draco-hub` forwarding path, MacBook route acceptance, tailnet policy, and
  native SSH data plane. Router logs then proved Preboot associated and
  completed DHCP on `.3` using the private identity; it never claimed `.250`.
  The off-LAN test therefore watched the wrong address and does not adjudicate
  the temporary Preboot SSH service. The first same-LAN `.3` failure may also
  include wireless client isolation. The temporary unlocked-host alias was
  removed after the isolation test. The later approved DHCP correction and
  renewal replaced that lease with `.250`. From the off-LAN MacBook, TCP 22
  then opened at `.250` and a fresh non-multiplexed key-only SSH session
  returned `RESERVED_ROUTE_OK user=draco host=dracos-mac-mini
  ip=192.168.1.250`. The corrected reservation and routed native-SSH data plane
  are accepted. A third approved locked reboot started at 20:37. The MacBook's
  key-only post-unlock validator first timed out, then repeatedly reached
  `.250` but received connection resets before SSH key exchange while the mini
  remained locked. The separate password-only FileVault unlock command then
  reached the same endpoint but was reset before it received an SSH banner or
  entered authentication. The operator unlocked locally at 20:40. This
  establishes locked-boot TCP reachability but a failed temporary SSH service,
  so unattended reboot recovery remains unaccepted.
- No UPS decision has been recorded.

### Installed tools

- Homebrew uses `/opt/homebrew`. Git, GitHub CLI, Codex, Command Line Tools,
  Clang, Rust/Cargo, Python/uv, and Node/pnpm are present for `draco`.
- Ansible, full Xcode, Flutter, FFmpeg, and Docker are absent. Ollama is
  installed but stopped and its downloaded models were removed.
- Administrator-account toolchains are discovery evidence, not the final
  runner environment. Required tools must be selected at Gate 1 and installed
  reproducibly for the dedicated runner identity.

### GitHub ownership and current intent

- Runner scope is the `pulseai-labs` GitHub organization. The organization
  currently contains 10 private repositories and four public repositories.
- Private repositories currently in scope are:
  `draco-hub-macos-server`, `pulse360`, `pulse-trader-internal`, `forge3d-ai`,
  `forge3d`, `pulsedb-internal`, `pulsebase-internal`, `pulsebase`,
  `pulse-narrator-internal`, and `pulsehive-internal`.
- Public repositories are `PulseDB`, `pulse-trader`, `PulseHive`, and
  `pulse-narrator`. The desired future use is bounded headless-agent review,
  security-audit, and QA automation—not general public-repository CI.
- Public repositories are excluded from persistent-runner access. Their future
  review, security-audit, and QA automation will use a separate GitHub App
  service, non-admin identity, credentials, and workspace. That service must
  treat pull-request content as untrusted data, must not execute or directly
  check out untrusted code, and must not share private-runner or signing state.
- Current public-repository workflows use GitHub-hosted Linux, macOS, and
  Windows runners. Observed requirements include Rust/Cargo, Python 3.12,
  Node.js 20/22, macOS ARM64 builds, and Xcode-version-sensitive Rust linking.
- No `pulseai-labs` runner is registered. The obsolete personal
  `draco28/ProjectPulse` runner and its administrator-account LaunchAgent were
  removed.

## Gate 1 status

Resolved:

1. GitHub scope is the `pulseai-labs` organization.
2. One runner group will allow only the 10 enumerated private repositories;
   public repositories are explicitly excluded.
3. Public-repository agent automation is a separate GitHub App service and
   security boundary, not a workflow routed to the persistent Actions runner.
4. The dedicated local identity will be non-admin; `github-runner` remains the
   proposed name.
5. Initial concurrency should remain one listener and one job unless explicitly
   changed.
6. Native macOS Screen Sharing is the approved GUI recovery channel, restricted
   to administrators and reached through Tailscale.
7. Tailnet policy will restrict inbound mini administration to the MacBook on
   native SSH TCP 22 and Screen Sharing TCP 5900, restrict the routed preboot
   address to MacBook TCP 22, and preserve existing connectivity among the
   other three current devices.

Still requiring explicit approval:

1. The private-repository workflow trust policy: which events and actors may
   route jobs to the persistent runner.
2. Exact Rust, Python, Node, Flutter, FFmpeg, and full-Xcode requirements.
3. Whether signing, Simulator, UI tests, keychain access, or an interactive
   login is required.
4. Dedicated external-SSD runner directory, mount requirements, and isolation
   from the existing `projects` and `backups` trees.

## Decisions requiring live evidence

These must be resolved on the Mac mini before runner installation:

1. Hardware model, chip architecture, RAM, storage, and macOS version.
2. Existing administrator accounts and the proposed runner account name.
3. Current Tailscale variant, device name, ownership, and applicable grants.
4. Remote Login and Screen Sharing state.
5. FileVault, firewall, sleep, wake, and power-failure behavior.
6. Existing Homebrew, Xcode, language toolchains, Codex, and GitHub CLI.
7. GitHub ownership topology:
   - one organization, allowing an organization-scoped runner;
   - several organizations under an enterprise;
   - or personal repositories, requiring repository-level registrations unless
     the projects are moved into an organization.
8. Required project capability matrix: Rust, Python, Node, Flutter, Xcode,
   signing, Simulator, FFmpeg, databases, and any native libraries.
9. Required concurrency and acceptable resource contention.
10. Whether any workflow requires an interactive GUI login or signing keychain.

## Runner topology decision

Prefer exactly one persistent runner listener for the first operational version.
This gives predictable serialization and avoids multiple jobs racing over ports,
simulators, caches, and keychains.

Choose runner scope from repository ownership rather than convenience:

- Organization repositories: one organization-level runner in a group limited
  to selected private repositories.
- Personal repositories: one registration/service instance per repository, or
  migrate repositories to a GitHub organization before scaling the setup.
- Multiple enterprise organizations: enterprise runner group with explicit
  organization and repository access.

Do not create several listeners merely to make jobs parallel. Parallelism must
be supported by a measured CPU, memory, storage, port, simulator, and keychain
isolation plan.

## Rebuild policy

The target is: macOS installation plus this repository plus externally stored
secrets can reproduce the server. Host-specific state that cannot be reproduced
must be named in the runbook and backed up or deliberately accepted as ephemeral.
