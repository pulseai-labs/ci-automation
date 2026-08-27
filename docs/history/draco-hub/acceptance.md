# Acceptance ledger

The Mac mini is not an operational CI server until every required item is
checked with live evidence. Add the verification command or GitHub run URL next
to each completed item.

## Repository and reproducibility

- [x] Private GitHub remote confirmed.
      Evidence (2026-08-02): `gh repo view` reports
      `pulseai-labs/draco-hub-macos-server` as `PRIVATE` with default branch
      `main`.
- [ ] Default branch and protection expectations recorded.
- [ ] `./scripts/validate.sh` passes on the MacBook.
- [x] `./scripts/validate.sh` passes on the Mac mini.
      Evidence (2026-08-02): required files, shell syntax, YAML parsing, and
      secret filename guard passed; Ansible syntax was skipped because Ansible
      is not installed.
- [ ] Configuration playbook is idempotent: second run reports no unintended
      changes.
- [ ] Rebuild procedure contains no dependency on conversation history.

## Host identity and security

- [x] macOS version, hardware architecture, RAM, and free storage recorded.
      Evidence (2026-08-02): macOS 26.5.1 on an M1 `Macmini9,1` with 16 GiB
      RAM, approximately 104 GiB internal free space, and approximately 337 GiB
      free on the external SSD.
- [ ] Dedicated administrator and non-admin runner identities confirmed.
- [x] FileVault state recorded; no silent security downgrade performed.
      Evidence (2026-08-02): FileVault remains on; Gatekeeper and SIP are also
      enabled.
- [ ] Firewall state and intended policy recorded.
- [ ] No personal credentials or data exist in the runner account.
- [ ] Repository and runner directories have verified ownership and permissions.

## Remote administration

- [x] MacBook reaches the mini using native SSH over Tailscale.
      Evidence (2026-08-02): fresh direct and alias sessions reached native
      macOS SSH through `dracos-mac-mini.tail71316d.ts.net`.
- [x] SSH public-key login works in a second independent session.
      Evidence (2026-08-02): dedicated ED25519 key succeeded from multiple
      independent, non-multiplexed MacBook sessions; password-only
      authentication is rejected and root login is prohibited.
- [x] SSH and Screen Sharing are not exposed through public addressing or
      router forwarding.
      Evidence (2026-08-02): distributed external TCP checks against the
      current public IPv4 and global IPv6 addresses found zero successful
      handshakes to ports 22 or 5900 using an independent 18-node service. Six
      of the same workers reached a known IPv6 HTTPS control. A separate
      service confirmed port 22 closed from five workers and port 5900 closed
      from 10 repeat workers; one earlier 5900 result was not reproducible and
      had no corresponding local Screen Sharing event. Tailscale reports UPnP,
      PCP, and NAT-PMP unavailable.
- [x] Tailnet policy restricts administration to intended identities/devices.
      Evidence (2026-08-02): the live policy matches
      `tailscale/policy.json`; Tailscale accepted its embedded allow/deny tests,
      the visual policy contains only the three intended grants, and no
      Tailscale SSH rule remains. The preboot grant permits only
      `praveens-macbook-pro-1` to reach `192.168.1.250` on TCP 22; its tests
      deny Screen Sharing, UDP 22, and TCP 22 from the other current devices.
      The operator confirmed fresh native SSH and Screen Sharing sessions from
      `praveens-macbook-pro-1` after publication.
- [x] Screen Sharing works over Tailscale, or an explicit decision records why
      it is disabled.
      Evidence (2026-08-02): Screen Sharing was enabled through the native
      System Settings control, persists after reopening Settings, and is
      restricted to the administrator ACL. The operator confirmed fresh
      MacBook view and control through
      `dracos-mac-mini.tail71316d.ts.net`; Remote Management remains off.
- [x] Recovery procedure tested before changing SSH or Tailscale configuration.
      Evidence (2026-08-02): multiple independent MacBook sessions remained
      open while the SSH drop-in was validated and installed; no SSH restart or
      Tailscale change was performed.

## Power and lifecycle

- [x] Automatic sleep cannot take the runner offline unexpectedly.
      Evidence (2026-08-02): the live AC profile and
      `scripts/configure-power.sh` both enforce `sleep=0`.
- [x] Wake-for-network setting is recorded and tested if relied upon.
      Evidence (2026-08-02): `womp=1` is recorded and verified, but is not a
      recovery dependency because automatic system sleep is disabled.
- [ ] Power-failure restart behavior is recorded and tested if supported.
      Current evidence (2026-08-02): `autorestart=1` is applied and verified;
      an actual power-loss recovery test has not been performed.
- [ ] UPS decision recorded.
- [ ] Runner is online after administrator logout.
- [ ] Runner and remote access recover after an explicitly approved reboot.
      Failed evidence (2026-08-02): after an approved reboot, neither the
      Tailscale address nor the prior runtime Wi-Fi address accepted the
      temporary FileVault SSH connection. Remote access returned only after
      the operator entered the FileVault password at the attached monitor. A
      fresh, non-multiplexed MacBook connection then succeeded through
      `dracos-mac-mini-1.tail71316d.ts.net` with the previously verified host
      key and reported `user=draco host=dracos-mac-mini`. This proves normal
      post-unlock recovery only; it does not satisfy unattended reboot
      recovery. A second approved test used the configured
      `192.168.1.250/32` subnet route with the MacBook off-LAN. TCP 22 never
      opened during continuous checks from 20:01 through 20:07, and the
      operator again had to unlock the mini physically. The routed preboot
      recovery path therefore remained failed. A third approved reboot at
      20:37 used the corrected `.250` reservation. The MacBook's key-only
      post-unlock validator first timed out and then repeatedly received
      pre-key-exchange connection resets from `.250` while the mini remained
      locked. The dedicated password-only FileVault unlock command also reached
      `.250` but was reset before the SSH banner, key exchange, or password
      authentication. The operator unlocked locally at 20:40. Locked-boot TCP
      reachability improved, but the temporary SSH service failed and
      unattended reboot recovery remains unaccepted.
- [x] FileVault pre-boot implications are tested and documented.
      Evidence (2026-08-02): preboot SSH was enabled and its host key matched
      the normal host, but the standard Tailscale application started only
      after physical unlock and the prior runtime Wi-Fi address was not a
      usable preboot recovery target. FileVault remains enabled. The runbook
      records the negative result and the proposed Wi-Fi preboot reservation
      plus `/32` subnet-router remediation. The router initially reserved
      `192.168.1.250` for the Preboot hardware Wi-Fi identity and was later
      corrected to the private identity observed in locked-boot DHCP logs. `draco-hub`
      advertises exactly `192.168.1.250/32`, the route is approved, and the
      live tested tailnet policy grants only the MacBook TCP 22 access to that
      address. A subsequent approved off-LAN FileVault-locked reboot test did
      not expose TCP 22 at that address during more than six minutes of
      polling; physical unlock was still required. After unlock, a temporary
      `192.168.1.250` alias on the running mini proved the same `/32` path:
      off-LAN TCP 22 succeeded and native key-only SSH returned
      `ROUTE_DATA_PLANE_OK user=draco host=dracos-mac-mini`. The route and
      policy are therefore healthy. Router DHCP logs subsequently proved that
      both locked boots associated successfully using the private Wi-Fi
      identity and received `192.168.1.3`; the hardware-identity `.250`
      reservation was never used. The off-LAN test therefore watched the wrong
      address. The router reservation was subsequently corrected and applied
      for the observed private identity. An authenticated DHCP renewal moved
      the unlocked mini from `.3` to `.250`; the default gateway remained
      `192.168.1.1`, native SSH TCP 22 was open locally, Remote Login remained
      enabled, FileVault remained on, and Tailscale remained connected. From
      the off-LAN MacBook, TCP 22 then succeeded at `.250` and a fresh
      non-multiplexed key-only SSH connection returned
      `RESERVED_ROUTE_OK user=draco host=dracos-mac-mini
      ip=192.168.1.250`. The corrected reservation, `/32` route, policy, and
      native-SSH data plane are accepted. During the subsequent locked reboot,
      `.250` became reachable but reset the key-only post-unlock validator
      before SSH key exchange. The dedicated password-only unlock command was
      also reset before it received an SSH banner or reached authentication.
      The temporary FileVault service is therefore tested and failed, not
      merely untested.

## GitHub topology and trust

- [x] Runner scope is explicitly repository, organization, or enterprise.
      Evidence (2026-08-02): operator selected organization scope at
      `https://github.com/pulseai-labs`; no runner is registered yet.
- [x] Allowed repositories are enumerated.
      Evidence (2026-08-02): `docs/server-spec.md` lists the 10 private
      `pulseai-labs` repositories allowed by the proposed runner group and
      explicitly excludes all public repositories.
- [ ] Public and fork pull-request policy prevents untrusted code from reaching
      the persistent runner.
- [ ] Runner group and labels route only intended jobs.
- [ ] Workflow token permissions are least privilege.
- [ ] Environments/approvals protect signing and release secrets where used.
- [ ] Registration credentials were handled just in time and not persisted.

## Runner operation

- [x] Dedicated non-admin runner identity exists with least-privilege ownership.
      Evidence (2026-08-03): `github-runner` uid 502, primary group
      `ghrunner` (gid 401), not `staff` and not a member of `admin`; no
      `com.apple.access_ssh` membership, so it has no shell access. Home is
      `/Users/github-runner` on the internal FileVault-protected volume, not
      `/Volumes/master_ssd` (which is `noowners` and unencrypted).
      `/Users/draco` tightened to 700. Created by
      `scripts/setup-github-runner.sh create`.
- [x] The agent toolchain runs headless as that identity, with no GUI session.
      Evidence (2026-08-03): `scripts/setup-github-runner.sh test` bootstrapped
      a transient LaunchDaemon as `github-runner` and returned
      `security-session=System`, `KEYCHAIN=unreachable`, model resolution
      `Available tools for glm-5.2` (rc=0), and inference `HEADLESS_OK` (rc=0).
      Credential is `auth.v2.file` (file backend, selected by
      `FACTORY_DISABLE_KEYRING=1` at login). No Factory subscription,
      no `FACTORY_API_KEY`, and no auto-login were required, so the FileVault
      posture in ADR-0002 is unchanged.
- [x] Credential plane established without any long-lived secret in GitHub.
      Evidence (2026-08-03): GitHub App `pulseai-ci` (app_id 4470964) installed
      org-wide at `repository_selection: all`, installation 150884244, webhooks
      deliberately inactive. Private key at `/usr/local/etc/pulseai-ci/app.pem`
      root:wheel 0400 — never a GitHub secret, never in a launchd plist.
      `scripts/install-app-key.sh` proved the chain: RS256 JWT accepted by
      `GET /app`, installation token minted with
      `{"contents":"read","issues":"write","metadata":"read"}`, then revoked.
      No per-repo deploy key is required, so onboarding a new project needs no
      access to the mini.
- [x] Administration credentials work without a console login session.
      Evidence (2026-08-03): `gh` token moved out of the login keychain to
      `~/.config/gh/token.env` (0600) and exported as `GH_TOKEN`, after three
      distinct SSH failures traced to one cause — `git` prompting for a
      password, `gh` returning 401 over SSH while succeeding on the console,
      and droid (fixed separately via `FACTORY_DISABLE_KEYRING=1`).
- [ ] Runner scope confirmed before registration.
      Current evidence (2026-08-03): `scripts/verify-runner-scope.sh` reports
      the org's single group `Default` with `allows_public_repositories: false`
      (the control that keeps fork PRs off this hardware) and zero registered
      runners, but `visibility: all` rather than the `selected` set of 10
      private repositories that ADR-0001 specifies. Also confirmed: no
      repo-scoped runners on any public repository, and no
      `pull_request_target` in any of the 4 public repositories.
      Update (2026-08-03): resolved. `scripts/create-runner-group.sh --apply`
      created group `mac-mini-private` (id 3) with
      `allows_public_repositories: false`. `visibility: private` is silently
      coerced to `all` by the API, so the intended state is expressed as
      `all` + `allows_public_repositories: false`, which excludes every public
      repo while covering all current and future private repos with no
      per-project edits. `scripts/verify-runner-scope.sh` now passes with zero
      failures and zero warnings; zero runners registered.
- [ ] Dedicated runner account owns and executes the runner.
- [ ] Runner is managed by the supported macOS `launchd` service.
- [ ] Exactly one initial listener is present, unless a documented concurrency
      design says otherwise.
- [ ] Runner is online in GitHub.
- [ ] Diagnostic checkout job passes.
- [ ] Representative Rust job passes if Rust is in scope.
- [ ] Representative Python job passes if Python is in scope.
- [ ] Representative Node job passes if Node is in scope.
- [ ] Representative Flutter job passes if Flutter is in scope.
- [ ] Representative Xcode/Simulator job passes if Apple builds are in scope.
- [ ] Signing/release job passes if signing is in scope.
- [ ] Cleanup behavior and retained caches are documented and verified.
- [ ] Logs expose no secrets.

## Operations

- [ ] Health/status command documented.
- [ ] Runner update behavior documented.
- [ ] macOS/Xcode maintenance window documented.
- [ ] Disk and cache growth thresholds documented.
- [ ] Backup versus reproducible/ephemeral state boundary documented.
- [ ] Failure and rollback runbook validated.
