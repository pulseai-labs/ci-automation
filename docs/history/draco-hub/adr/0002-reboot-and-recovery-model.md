# ADR-0002: Reboot and recovery model

- Status: Accepted
- Date: 2026-08-03
- Deciders: Draco
- Resolves: outstanding item 1 of `docs/change-report-2026-08-02.md`

## Context

The mini keeps FileVault enabled. On every boot it stops at the unlock screen —
no data volume, no Tailscale, no sshd, no runner — until the password is
entered. A root LaunchDaemon therefore cannot start before unlock, and GitHub
Actions cancels queued jobs after 24 hours.

Apple's designed remedy on Apple silicon is preboot SSH unlock (`sshd-fvunlock`).
It is correctly provisioned on this host: `sshd-fvunlock.plist` is
`{"Enabled" => true}`, and the staged preboot host keys under
`/System/Volumes/Preboot/<UUID>/var/db/sshd/` match `/etc/ssh/ssh_host_*_key`
exactly (all `Aug 2 13:59`).

It nevertheless failed three tests. The root cause is **not** the network layer,
contrary to `docs/server-spec.md:140-145`: on the 20:37 boot the preboot
environment associated over WPA2-PSK, completed DHCP and took `192.168.1.250`
about 13 seconds after boot, and TCP 22 was reachable. `ssh.plist` runs
`/usr/libexec/sshd-keygen-wrapper` under `inetdCompatibility`, so **launchd owns
the listening socket and completes the TCP handshake itself**, then spawns the
wrapper per connection. The wrapper failed host-key setup — `Failed to generate
host key` ×3 then `AppleKeyStore.AKSError Code=5` — and exited before `exec`ing
`sshd`, so launchd closed the accepted socket. That is exactly the observed
`kex_exchange_identification: read: Connection reset by peer`.

Since the staged keys are current, this points at a BaseSystem keystore
limitation in macOS 26.5.1, not a misconfiguration. Further reboot testing has
no remaining hypothesis to discriminate.

The operator has a UPS and is not concerned about unexpected power loss. The
stated requirements are: survive macOS update restarts, and never sleep.

## Decision

**Keep FileVault. Make every reboot operator-initiated and credentialed. Accept
physical unlock for the residual case.**

1. **Never sleep** — already satisfied and verified: `sleep 0`, `standby 0`,
   `disksleep 0`, `womp 1`, `autorestart 1`. `displaysleep 60` blanks only the
   monitor. No change required.

2. **Disarm automatic macOS updates.** Currently `AutomaticallyInstallMacOSUpdates
   = 1` with macOS Tahoe 26.6 pending and `Action: restart` — the mini is armed
   to reboot itself into a lock screen. Set it to `false`; keep
   `ConfigDataInstall` and `CriticalUpdateInstall` at `1` for XProtect, and
   `AutomaticDownload` at `1` so updates stage.

3. **Update deliberately, over SSH, with credentials.** Apple silicon supports
   `softwareupdate --user <admin> --stdinpass`; password via stdin, never argv:

   ```bash
   read -rs -p "FileVault password: " P && printf '%s' "$P" \
     | sudo softwareupdate -i -R --user draco --stdinpass; unset P
   ```

4. **Plain reboots use `sudo fdesetup authrestart`** (`supportsauthrestart` →
   `true` on this host), which holds the unlock key in memory and returns the
   host unattended.

5. **Preboot SSH unlock is parked, not abandoned.** File Feedback Assistant with
   the `AKSError=5` trace. Do not spend further reboots on it. Do not revert the
   `.250` DHCP reservation — it is proven correct and the preboot environment
   demonstrably claims that address.

6. **No IP-KVM purchase at this time.** Revisit only if downtime proves painful.

## Consequences

- Every reboot the operator initiates returns unattended. This covers the stated
  requirement.
- An outage that outlasts the UPS still requires walking to the machine. Accepted.
- Because unattended recovery is not guaranteed, **monitoring is not optional**:
  the operator must learn the mini is down from an alert, not from a failed CI
  job. That work is tracked separately as Phase B.
- The Tailscale node key expiring **2026-10-27** interacts badly with this model:
  CI keeps running, but SSH is lost, and physical access becomes the only
  channel. Disabling key expiry on the mini is a prerequisite, not a nicety.
- `docs/server-spec.md:140-145` must be corrected: it records a disproven root
  cause and, left as-is, sends the next operator back into the network layer.
