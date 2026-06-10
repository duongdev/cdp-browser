// Injected into Slack's SERVICE WORKER target (t067), not the page. Slack delivers many
// notifications from its service worker's `push` handler via
// `self.registration.showNotification(...)` — a realm the page hook (slack-notify.js's
// `window.Notification` patch) can't reach. This script patches
// `ServiceWorkerRegistration.prototype.showNotification` in the worker's global scope and
// ships the same `__cdpNotify` toast the side-channel ingests.
//
// EXPERIMENTAL / HITL: Slack's push payload shape is not publicly documented, so the
// team/channel extraction below probes the common carriers defensively and degrades to a
// tab-/origin-only toast when it can't find them. Verify against a live Slack SW push and
// tighten the probes (the captured `options.data` is logged to the worker console once).
//
// Realm notes:
//   - No `window` / `document` here — only `self`, `self.registration`, the global
//     `ServiceWorkerRegistration`, and the `__cdpNotify` binding the side-channel registers
//     via Runtime.addBinding before this runs.
//   - The single Slack SW serves EVERY workspace (app.slack.com origin-level), so the SW URL
//     carries no team id. The per-workspace groupKey must come from the payload, not the URL.
//   - We deliberately let the real showNotification still run so the user isn't left with a
//     silently-swallowed push (the remote browser's own toast is harmless and offscreen);
//     capture is purely additive.
;(() => {
  if (self.__cdpSwNotifyArmed) return
  self.__cdpSwNotifyArmed = true

  let seq = 0
  let loggedShape = false

  const CHANNEL_RE = /\b([CDG][A-Z0-9]{6,})\b/
  const TEAM_RE = /\b([TE][A-Z0-9]{6,})\b/

  // Pull the first well-formed id matching `re` out of a grab-bag of probe strings drawn
  // from the notification options (tag + data, object or scalar, plus a JSON dump).
  const probe = (opts, re) => {
    if (!opts || typeof opts !== "object") return null
    const probes = []
    if (opts.tag != null) probes.push(String(opts.tag))
    const d = opts.data
    if (d != null) {
      if (typeof d === "object") {
        for (const k of ["team", "teamId", "team_id", "channel", "channelId", "channel_id", "id"]) {
          if (d[k] != null) probes.push(String(d[k]))
        }
        try {
          probes.push(JSON.stringify(d))
        } catch {
          /* circular — skip */
        }
      } else {
        probes.push(String(d))
      }
    }
    for (const p of probes) {
      const m = p.match(re)
      if (m) return m[1]
    }
    return null
  }

  const capture = (title, opts) => {
    if (!loggedShape) {
      loggedShape = true
      try {
        // One-time aid for tightening the probes against the real payload (HITL).
        console.log("[cdp-sw-notify] sample options:", JSON.stringify(opts))
      } catch {}
    }
    const team = probe(opts, TEAM_RE)
    const channel = probe(opts, CHANNEL_RE)
    const body = opts && typeof opts.body === "string" ? opts.body : ""
    const payload = {
      id: `slack-sw:${team || "?"}:${Date.now()}:${seq++}`,
      source: "Slack",
      title: title != null ? String(title) : "",
      body,
      // Per-workspace bucket from the payload (the SW URL has no team id). When absent the
      // side-channel falls back to the SW origin — all workspaces merge, but still captured.
      groupKey: team ? `slack:${team}` : undefined,
      activate: channel && team ? { type: "spa-link", url: `/client/${team}/${channel}` } : null,
      ts: Date.now(),
    }
    try {
      self.__cdpNotify(JSON.stringify(payload))
    } catch {
      /* binding not registered (shouldn't happen) */
    }
  }

  const proto =
    typeof ServiceWorkerRegistration !== "undefined" && ServiceWorkerRegistration.prototype
  if (!proto || typeof proto.showNotification !== "function") return
  const real = proto.showNotification
  proto.showNotification = function patchedShowNotification(title, opts, ...rest) {
    try {
      capture(title, opts)
    } catch {
      /* never break the worker */
    }
    // Still call through so the push handler's contract is honoured.
    try {
      return real.call(this, title, opts, ...rest)
    } catch {
      return Promise.resolve()
    }
  }
})()
