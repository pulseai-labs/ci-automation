# Bootstrap runbook

## One-time physical or existing remote access

Tailscale provides connectivity but does not by itself start a shell service.
If no remote-management service is currently enabled, use existing physical or
GUI access to the Mac mini once.

On the Mac mini:

1. Open **System Settings → General → Sharing**.
2. Enable **Remote Login**.
3. Restrict it to the intended administrator account; do not choose all users.
4. Optionally enable **Screen Sharing** for that same administrator as a GUI
   recovery path.
5. Confirm Tailscale is connected and note the non-sensitive MagicDNS device
   name.

Do not enable router port forwarding for SSH or Screen Sharing.

## Establish SSH from the MacBook

Generate a dedicated key on the MacBook if an appropriate one does not already
exist:

```bash
ssh-keygen -t ed25519 -a 64 -f ~/.ssh/id_ed25519_mac_mini_ci
```

Install only the public key on the Mac mini, then verify a new independent
session before changing password-authentication policy:

```bash
ssh -i ~/.ssh/id_ed25519_mac_mini_ci ADMIN_USER@MAC_MINI_MAGICDNS_NAME
```

An optional MacBook SSH config entry:

```sshconfig
Host draco-mac-mini
  HostName MAC_MINI_MAGICDNS_NAME
  User ADMIN_USER
  IdentityFile ~/.ssh/id_ed25519_mac_mini_ci
  IdentitiesOnly yes
```

The final host name, user, and Tailscale policy must be derived from live state.

## Publish and clone this repository

After the private GitHub repository exists, from the MacBook copy:

```bash
git remote add origin https://github.com/pulseai-labs/draco-hub-macos-server.git
git push -u origin main
```

Then, on the Mac mini:

```bash
git clone https://github.com/pulseai-labs/draco-hub-macos-server.git
cd draco-hub-macos-server
mkdir -p local
./scripts/collect-host-facts.sh | tee local/host-facts.md
./scripts/validate.sh
```

Authentication for a private clone should use GitHub CLI, a credential helper,
or a narrowly scoped deploy credential. Do not embed credentials in the remote
URL.

## Invoke Codex on the Mac mini

Start Codex in the repository root and provide:

```text
Read AGENTS.md and docs/codex-handoff.md completely. Execute the handoff
depth-first. Begin with read-only discovery, record decisions before writing
machine-changing automation, and stop at every explicit approval gate.
```

The first Codex response should be a live-state discovery and Gate 1 decision
report, not immediate package installation.

## Recovery principle

Always retain two verified paths before changing remote access:

- the current working SSH session; and
- either a second independently tested SSH session or Screen Sharing/physical
  access.

Never restart SSH, Tailscale, networking, or the Mac while relying on the only
active session for recovery.

## Test FileVault recovery after a restart

Run this test only with explicit reboot approval and physical access available
for the first attempt. Apple-silicon Macs on macOS 26 or later can accept a
password over a temporary preboot SSH service when FileVault is locked, Remote
Login is enabled, and the active network is either unauthenticated Ethernet or
a previously joined open/WPA2-PSK Wi-Fi network. The normal sshd configuration,
authorized keys, and shell are unavailable until the data volume is unlocked.

Before restarting, verify:

```bash
fdesetup status
sysadminctl -secureTokenStatus draco
launchctl print-disabled system | grep com.openssh.sshd
ipconfig getsummary en1
```

Keep the MacBook on the same LAN as the mini. Do not rely on the standard
Tailscale macOS application while FileVault is locked: it is stored on the
locked data volume and the 2026-08-02 test showed it starting only after
physical unlock. Reach the temporary preboot SSH service through a stable LAN
path instead. Use a separate known-hosts file because the preboot service is
distinct from the normal native SSH service:

```bash
ssh -o ConnectTimeout=10 \
  -o PreferredAuthentications=password \
  -o PubkeyAuthentication=no \
  -o UserKnownHostsFile=/tmp/draco-filevault-known-hosts \
  -o StrictHostKeyChecking=accept-new \
  draco@192.168.1.250
```

For recovery while the MacBook is outside the home LAN, the active target
architecture is a separate always-on Tailscale subnet router advertising only
the mini's reserved `/32` LAN route. Tailnet policy allows only the MacBook to
reach TCP 22 on that routed address. Do not advertise the whole LAN merely for
this recovery path, and do not expose the preboot service through router port
forwarding.

The mini is constrained to Wi-Fi because it cannot be cabled to the router.
Its normal session can use a private Wi-Fi MAC while the Preboot network state
contains the hardware Wi-Fi MAC. Treat these as separate DHCP identities; do
not assume the normal runtime lease is the preboot address.

Before another reboot test, complete and verify all of these prerequisites:

1. Confirm the joined network uses WPA2-PSK, which Apple supports for this
   preboot feature.
2. Discover the hardware Wi-Fi address without committing it to Git:

   ```bash
   networksetup -listallhardwareports | awk \
     '/Hardware Port: Wi-Fi/{found=1; next} found && /Ethernet Address:/{print $3; exit}'
   ```

3. In the router, reserve a known unused LAN address for the identity actually
   observed in locked-boot DHCP logs. Do not create port forwarding or a DMZ
   rule.
4. Treat the normal private-MAC and hardware identities separately until live
   DHCP evidence proves which identity Preboot uses.
5. Confirm the reserved address is within the LAN path reachable from
   `draco-hub`. If off-LAN recovery is required, configure and approve only
   that `/32` route, then verify MacBook-only TCP 22 access.
6. During the next approved reboot, watch the router's client/lease view and
   confirm the preboot client actually receives the reserved address before
   attempting password SSH.
7. Keep physical fallback available and obtain explicit reboot approval again.

Current remediation state (2026-08-02): router DHCP logs prove both
FileVault-locked boots used the mini's private Wi-Fi identity: the first boot
received `.3` at 16:56 and the second at 20:02. The original hardware-identity
reservation was therefore based on an incorrect assumption and was never used
by Preboot. The router reservation has now been replaced and applied so that
the observed private identity receives `192.168.1.250`. After an authenticated
DHCP renewal, the unlocked mini obtained `.250` on `en1`, retained gateway
`192.168.1.1`, accepted native SSH on TCP 22, and remained connected to
Tailscale.
`draco-hub` now advertises exactly `192.168.1.250/32`, and that route is
approved in the tailnet. The live policy tracked in `tailscale/policy.json`
permits only `praveens-macbook-pro-1` to reach that address on TCP 22 and
contains tests denying TCP 5900, UDP 22, and TCP 22 from the other current
devices. Tailscale accepted the policy and its tests on 2026-08-02. The next
off-LAN MacBook test succeeded: TCP 22 opened at `.250`, and a fresh
non-multiplexed key-only SSH session returned
`RESERVED_ROUTE_OK user=draco host=dracos-mac-mini ip=192.168.1.250`. The
corrected reservation and routed native-SSH data plane are accepted. The next
approved FileVault-locked reboot at 20:37 did not establish remote unlock. The
MacBook ran the key-only post-unlock validator while the mini was still locked;
it first timed out and then repeatedly received connection resets before SSH
key exchange from `.250`. The operator unlocked locally at 20:40. These resets
show that the corrected address became reachable during the locked phase. The
dedicated password-only FileVault command also reached `.250`, but the peer
reset the connection before sending an SSH banner, performing key exchange, or
requesting a password. The temporary service is therefore tested and failed;
unattended reboot recovery remains unaccepted. Do not repeat the same test
without a materially different diagnostic or design, and do not open a router
port or broaden the route or policy.

Enter the `draco` account password interactively; never place it in a command,
file, or chat. Successful authentication unlocks FileVault and intentionally
disconnects that temporary SSH session while macOS mounts the data volume and
starts normal services. Wait for the host to boot, then verify the hardened
key-only path and GUI recovery path:

```bash
ssh -o ControlMaster=no -o ControlPath=none \
  draco@dracos-mac-mini-1.tail71316d.ts.net \
  'printf "POST_REBOOT_SSH_OK user=%s host=%s\\n" "$(whoami)" "$(hostname)"'
open 'vnc://dracos-mac-mini-1.tail71316d.ts.net'
```

If the preboot path does not respond within three minutes, unlock the mini
physically. Do not weaken FileVault, expose SSH publicly, or change the
Tailscale installation to work around a failed test.

### Observed result: 2026-08-02

The first approved test used the standard Tailscale address and the mini's
prior runtime Wi-Fi address:

```bash
ssh -o ConnectTimeout=10 \
  -o PreferredAuthentications=password \
  -o PubkeyAuthentication=no \
  -o UserKnownHostsFile=/tmp/draco-filevault-known-hosts \
  -o StrictHostKeyChecking=accept-new \
  draco@192.168.1.3
```

Neither target responded before FileVault unlock. The operator had to enter
the account password at the attached monitor. After unlock, normal macOS and
Tailscale services started and remote access returned. Inspection then showed
that preboot SSH was enabled, its host keys were present, and its ED25519
fingerprint matched the normal host. This result establishes a preboot network
reachability gap; it does not justify disabling FileVault or weakening SSH.

### Observed result: routed off-LAN test, 2026-08-02

After configuring the router reservation, the exact `192.168.1.250/32`
subnet route, and the MacBook-only TCP 22 policy grant, a second approved test
placed the MacBook on a hotspot and rebooted the mini with physical fallback
available. The MacBook continuously tested TCP 22 on `192.168.1.250` from
20:01 through 20:07. The port never opened, and the operator again unlocked
the mini at its attached monitor.

After unlock, the mini confirmed FileVault remained on, Remote Login remained
enabled, and the Preboot `sshd-fvunlock.plist` still contained `Enabled=true`.
The Preboot network configuration contains the hardware Wi-Fi interface and
automatic join mode. Router DHCP logs provide stronger live evidence: at
16:56 during the first locked boot and 20:02 during the second, the mini's
private Wi-Fi identity sent DHCP discovery, accepted the router's `.3` offer,
and received an acknowledgement. Preboot therefore joined Wi-Fi successfully
but did not use the hardware identity reserved at `.250`. A subsequent
unlocked-host isolation test temporarily assigned
`192.168.1.250` to `en1`. From the off-LAN MacBook, TCP 22 opened and native
key-only SSH returned
`ROUTE_DATA_PLANE_OK user=draco host=dracos-mac-mini`. This proves the
`draco-hub` forwarding path, Tailscale route acceptance, tailnet policy, and
native SSH path. The off-LAN reboot test watched an address Preboot never
claimed, so it does not test the temporary SSH service. The first same-LAN `.3`
failure may also include wireless client-isolation behavior and is not enough
to reject the routed design. The temporary alias was removed after the test;
live verification showed only the normal `192.168.1.3` address remained on
`en1`.

After the reboot, the live Tailscale machine name was
`dracos-mac-mini-1`. The earlier unsuffixed MagicDNS name no longer resolves
from the mini. Revalidate the direct MacBook connection, update the local SSH
alias if necessary, and test a fresh alias connection before treating it as a
recovery path. A fresh non-multiplexed connection using an explicit
`HostName=dracos-mac-mini-1.tail71316d.ts.net` override subsequently succeeded
with the expected host key. The plain `draco-mac-mini` alias still requires
revalidation without that override. The test does not establish what caused
the name change.
