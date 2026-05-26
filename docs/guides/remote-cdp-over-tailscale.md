# Reaching a remote CDP browser through a Tailscale jump host

How to connect CDP Browser to a Chromium/Edge instance that runs on a machine
you **cannot reach directly** — no public IP, no inbound SSH, often a locked-down
or MDM-managed box — by relaying through a small always-on device on your tailnet.

## When to use this

- The browser machine (**A**) can only make *outbound* LAN connections. You can't
  SSH into it, you can't change its firewall, and CDP is bound to `127.0.0.1`.
- You have a second always-on device (**B**) on the same LAN as A, running
  [Tailscale](https://tailscale.com/) — e.g. a Raspberry Pi, NAS, or KVM-over-IP
  appliance.
- Your workstation (**C**) running CDP Browser is on the tailnet and can reach B
  from anywhere.

```
A (browser, CDP on 127.0.0.1:9222)        C (CDP Browser)
        │ outbound SSH (LAN)                       │ Tailscale
        ▼                                          ▼
        B  ──────────── on the tailnet ────────────┘
        (jump host: Tailscale + LAN)
```

Because A can only connect *out*, the data path is built in two stages that meet
on B's loopback:

1. **A → B reverse tunnel** (`ssh -R`): A pushes its local CDP port up to B's
   loopback. A initiates, so no inbound access to A is needed and CDP can stay
   bound to `127.0.0.1`.
2. **B exposes the loopback port on its tailnet IP** so C can reach it. C then
   points CDP Browser at `B-tailscale-ip:9222`.

Throughout, replace these placeholders:

| Placeholder           | Meaning                                  | Example          |
|-----------------------|------------------------------------------|------------------|
| `B_LAN_IP`            | B's address on the LAN (A reaches this)  | `192.168.1.50`   |
| `B_TAILSCALE_IP`      | B's tailnet IP (C reaches this)          | `100.x.y.z`      |
| `B_USER`              | SSH user on B                            | `root`           |
| `9222`                | CDP debugging port                       | `9222`           |

---

## Step 1 — Launch the browser on A with CDP enabled

```bash
# Chrome / Chromium / Edge — pick one
chromium --remote-debugging-port=9222 --remote-allow-origins=*
```

`--remote-allow-origins=*` relaxes the WebSocket origin check that newer Chromium
enforces; without it the tunneled WebSocket upgrade can be rejected. CDP stays
bound to `127.0.0.1` — that's fine, the reverse tunnel originates on A and points
at A's own loopback.

Verify locally on A: `curl http://localhost:9222/json/version`.

## Step 2 — A pushes a reverse tunnel to B

On A:

```bash
ssh -N -R 9222:localhost:9222 B_USER@B_LAN_IP
```

This publishes A's `localhost:9222` as **B's `localhost:9222`**. By default `ssh -R`
binds the forward to B's loopback only — which is exactly what we want for step 3.

Verify on B: `curl http://localhost:9222/json/version` should return A's browser.

## Step 3 — Expose B's loopback port on its tailnet IP

The reverse tunnel only listens on B's loopback, so C can't reach it across
Tailscale yet. Bridge it with [`socat`](http://www.dest-unreach.org/socat/):

```bash
socat TCP-LISTEN:9222,bind=B_TAILSCALE_IP,fork,reuseaddr TCP:127.0.0.1:9222
```

> **Why a bridge instead of `ssh -R 0.0.0.0:9222`?**
> Binding a reverse forward to all interfaces needs `GatewayPorts yes` in the
> server's SSH config. Some appliances ship a minimal SSH server (e.g.
> **Dropbear**) that ignores the `0.0.0.0:` prefix entirely and needs a separate
> flag to allow non-loopback forwards. Bridging with `socat` sidesteps server
> config and keeps the port off the LAN — it's only reachable on the tailnet IP.

Verify from C: `curl http://B_TAILSCALE_IP:9222/json/version`.

## Step 4 — Point CDP Browser at B

In Settings, set **Host** = `B_TAILSCALE_IP`, **Port** = `9222`.

### A note on the CDP `Host` header

CDP rejects requests whose `Host` header is neither `localhost` nor an IP address
(`403 Host header is specified and is not an IP address or localhost`). Connecting
to a tailnet **IP** satisfies this. If you front the tunnel with a hostname
instead, you'll hit the 403 — use the IP, or add `--remote-allow-origins=*` on A.

---

## Making it survive reboots

The chain has two fragile links. Harden both.

### A's reverse tunnel — auto-redial + keepalive

A bare `ssh -R` dies silently when the network blips or B reboots, and never comes
back. Wrap it so it reconnects, and add keepalives so it detects a dead link
quickly:

```bash
autossh -M 0 -N \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -R 9222:localhost:9222 B_USER@B_LAN_IP
```

- `ServerAliveInterval × ServerAliveCountMax` is how long a dead link lingers
  before the tunnel gives up and reconnects (here ~45s). Lower both for faster
  recovery.
- `ExitOnForwardFailure=yes` fails fast if the remote bind fails, so the
  supervisor can re-establish instead of holding a half-open tunnel.

For passwordless reconnect, use key auth (`ssh-keygen` on A, append the public key
to B's `authorized_keys`). On Dropbear that's the target user's
`~/.ssh/authorized_keys`.

**On a desktop OS, run it from a login-scoped supervisor** so it starts on login
and respawns on exit — e.g. a macOS LaunchAgent (`~/Library/LaunchAgents`, no root
needed) or a systemd **user** service with `Restart=always`. The same supervisor
can launch the browser with `--remote-debugging-port=9222`.

#### macOS recipe — launchd (no autossh needed)

On macOS, launchd *is* the redialer: `KeepAlive` respawns `ssh` whenever it exits,
and the keepalive options make `ssh` exit promptly on a dead link — so plain `ssh`
(built in, nothing to install on a locked-down Mac) is enough. First set up key
auth A → B, then drop this at `~/Library/LaunchAgents/dev.cdp.tunnel.plist`
(replace `B_USER`/`B_LAN_IP`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.cdp.tunnel</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/ssh</string>
    <string>-N</string>
    <string>-o</string><string>ServerAliveInterval=15</string>
    <string>-o</string><string>ServerAliveCountMax=3</string>
    <string>-o</string><string>ExitOnForwardFailure=yes</string>
    <string>-o</string><string>BatchMode=yes</string>
    <string>-o</string><string>StrictHostKeyChecking=accept-new</string>
    <string>-R</string><string>9222:localhost:9222</string>
    <string>B_USER@B_LAN_IP</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardErrorPath</key><string>/tmp/cdp-tunnel.log</string>
  <key>StandardOutPath</key><string>/tmp/cdp-tunnel.log</string>
</dict></plist>
```

```bash
launchctl load -w ~/Library/LaunchAgents/dev.cdp.tunnel.plist   # start + enable at login
launchctl list | grep cdp.tunnel                                # 2nd column = last exit code
tail -f /tmp/cdp-tunnel.log                                      # watch reconnects
```

Why each flag earns its place:

- `RunAtLoad` → starts at login (≈ boot for a desktop you log into).
- `KeepAlive` → respawns `ssh` on **any** exit — network blip, B reboot, Mac wake-from-sleep.
- `ServerAliveInterval=15 × CountMax=3` → `ssh` notices a dead link and exits in ~45s (lower for faster recovery), handing control back to launchd.
- `ExitOnForwardFailure=yes` → if B's port is still held by a not-yet-reaped old tunnel, `ssh` exits immediately instead of sitting there portless; launchd retries every `ThrottleInterval` (10s) until B frees it.
- `BatchMode=yes` → never blocks on a password prompt (needs key auth).

> **One browser instance owns the profile.** If you want CDP against your *normal*
> profile, the supervised launch must be the only instance — opening the browser
> separately first means the second (CDP-flagged) launch just hands off to the
> running one and no debugger port opens. Use a dedicated `--user-data-dir` to
> avoid the conflict, or always let the supervisor start it.

### B's bridge — start on boot, self-respawn

Run `socat` from a boot hook and supervise it. Two portability notes for minimal
appliances:

1. **The tailnet IP may not exist yet at boot.** Don't bind blindly — poll for it,
   then start `socat`, and restart if it ever exits:

   ```sh
   #!/bin/sh
   PORT=9222
   while true; do
       IP=$(tailscale ip -4 2>/dev/null | head -1)
       [ -n "$IP" ] && socat TCP-LISTEN:$PORT,bind=$IP,fork,reuseaddr TCP:127.0.0.1:$PORT
       sleep 5
   done
   ```

2. **Detach the loop from the boot process.** If the init runner starts your script
   synchronously and the loop is a plain `&` child, it can be reaped when the boot
   sequence finishes. Launch it with `setsid ... </dev/null &` so it lands in its
   own session and is orphaned to init.

3. **Use the platform's *supported* boot hook, and verify with a real reboot.**
   On systemd, a unit with `Restart=always` ordered `After=tailscaled.service`.
   On minimal/SysV-style firmware, find the vendor's user-script directory rather
   than dropping a file late in the global init order — a high-numbered script can
   be skipped if an earlier long-running service blocks the runner. Always confirm
   by rebooting and re-checking, not just by running the script by hand.

### B must reap dead tunnels, or **reconnect is blocked**

The most confusing failure: A's tunnel dies *uncleanly* (Mac sleeps, wifi drops),
but B's SSH server doesn't notice and keeps the reverse forward bound to
`127.0.0.1:9222`. Now A's supervisor redials and the new tunnel can't bind the
port — `Warning: remote port forwarding failed for listen port 9222` — and you're
stuck until the stale listener finally times out (can be many minutes). Symptom on
B: a `127.0.0.1:9222` LISTEN owned by the *old* SSH session that A no longer has.

Fix: make B's SSH server send keepalives so it drops dead clients (and frees the
port) within seconds — matching A's redial.

- **Dropbear** (typical on appliances): add `-K 30` (keepalive every 30s; it
  disconnects a client that misses replies). Set it where the appliance launches
  Dropbear — often `DROPBEAR_EXTRA_ARGS="-K 30"` in `/etc/default/dropbear`, or the
  vendor's init script. Restart Dropbear and reboot-test.
- **OpenSSH server** (if B runs it): `ClientAliveInterval 30` + `ClientAliveCountMax 3`
  in `sshd_config`.

If you genuinely can't change B's SSH server, the port still self-clears on TCP
timeout and A's `ExitOnForwardFailure` + supervisor will keep retrying until it
does — just slower (minutes, not seconds). The client-side `ServerAliveInterval`
on A only makes *A* give up fast; only B-side keepalive frees *B's* port fast.

---

## Troubleshooting

| Symptom | Likely cause | Check |
|---------|--------------|-------|
| `curl B_TAILSCALE_IP:9222` hangs/refused | `socat` not listening on the tailnet IP | On B: `ss -tlnp \| grep 9222` — expect a `socat` line bound to the tailnet IP |
| `socat` up but `curl localhost:9222` on B fails | A's reverse tunnel is down | On B: look for a `127.0.0.1:9222` LISTEN; on A check the tunnel/supervisor |
| `403 Host header ...` | Connecting via hostname, or strict origin check | Use the tailnet **IP**; add `--remote-allow-origins=*` on A |
| Works, then dies after a reboot | Boot hook didn't run, or loop was reaped | Reboot and re-check; ensure `setsid` detach and a supported hook |
| `remote port forwarding failed for listen port 9222` on redial | B still holds the old (dead) reverse forward | Give B-side SSH keepalive (`-K 30` on Dropbear / `ClientAliveInterval` on OpenSSH); to unblock now, on B kill the stale `127.0.0.1:9222` LISTEN owner |
| Connects but `/json` hangs with 0 bytes | Half-dead tunnel: B's listener is up but A's link is gone | Same as above — B-side keepalive frees it; confirm A's supervisor is redialing |
| Slow (~30–60s) recovery after a blip | SSH keepalive window | Lower `ServerAliveInterval` / `ServerAliveCountMax` on A |

## Security notes

- The CDP port grants **full control** of the browser (read pages, cookies,
  navigate, execute script). Keep it off the public internet.
- Bridging to the **tailnet IP** (not `0.0.0.0`) limits exposure to your tailnet.
  Tighten further with Tailscale ACLs so only C can reach B's port.
- Prefer SSH **key** auth over passwords for the A → B hop.
