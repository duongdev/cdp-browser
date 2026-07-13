// Injected into Slack remote pages (document-start on every load + once immediately on
// attach). Unlike Teams/Outlook — which scrape an in-app toast DOM node — Slack has no
// in-app toast: it fires desktop notifications through the Web Notifications API. So this
// script patches `window.Notification` at document-start, capturing every notification
// Slack tries to fire and shipping it through the `__cdpNotify` binding the side-channel
// registers. Pure capture — never navigates, never raises a real OS notification on the
// remote machine. (Service-worker `push`-handler notifications are out of scope — see the
// note at the foot of this file.)
//
// Findings this relies on (verified live against Edge 148 / Slack web, 2026-06-03):
//   - URL is app.slack.com/client/{TEAM}/{CHANNEL}; teamId is T… (standard) or E…
//     (Enterprise Grid); the server derives the per-workspace groupKey from the Tab URL.
//   - Notification.permission was "default" on the live tab, so Slack would NOT fire
//     unless we force the permission getter to "granted" — this override is load-bearing.
//   - workspace name is in .p-ia4_home_header_menu__team_name, else document.title
//     ("{ctx} - {WORKSPACE} - N new item - Slack"), else the hostname.
//   - the notification's target channel id (for a best-effort deep-link) may live in the
//     Notification options `data`/`tag`; absent → Tab-only activation (decision B → A).
;(() => {
  if (window.__cdpNotifyArmed) return
  window.__cdpNotifyArmed = true

  let seq = 0

  const text = (el) => (el ? (el.innerText || el.textContent || "").trim() : "")

  // teamId from the unified-client path (app.slack.com/client/{TEAM}/…) — a `*.slack.com`
  // subdomain is a workspace name, never a team id, so it yields "" (t104). Mirrors
  // core/notifications.js parseSlackContext; kept inline because an injected script can't
  // require the core module.
  const teamId = () => {
    const m = location.pathname.match(/\/client\/([TE][A-Z0-9]+)/)
    return m ? m[1] : ""
  }

  // Best-effort workspace name for display: the team-switcher label, else the middle
  // segment of the document title, else the hostname. Cosmetic — grouping keys on teamId.
  const workspaceName = () => {
    const el = document.querySelector(".p-ia4_home_header_menu__team_name")
    const dom = text(el)
    if (dom) return dom
    const parts = (document.title || "").split(" - ").map((s) => s.trim())
    // "{ctx} - {WORKSPACE} - N new item - Slack" | "{WORKSPACE} - Slack"
    if (parts.length >= 2 && parts[parts.length - 1] === "Slack") {
      const cand = parts[parts.length - 2]
      if (cand && !/\bnew (item|message)/i.test(cand)) return cand
      if (parts.length >= 3) return parts[parts.length - 3]
    }
    return location.hostname
  }

  // Slack channel id (C channel / D dm / G group) from the notification options, for a
  // best-effort SPA deep-link. Slack's exact `data`/`tag` shape isn't documented, so probe
  // the common carriers defensively and only accept a well-formed id. Null → Tab-only.
  const CHANNEL_RE = /\b([CDG][A-Z0-9]{6,})\b/
  const channelIdFrom = (opts) => {
    if (!opts || typeof opts !== "object") return null
    const probes = []
    if (opts.tag != null) probes.push(String(opts.tag))
    const d = opts.data
    if (d != null) {
      if (typeof d === "object") {
        for (const k of ["channel", "channelId", "channel_id", "id"]) {
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
      const m = p.match(CHANNEL_RE)
      if (m) return m[1]
    }
    return null
  }

  const capture = (title, opts) => {
    const team = teamId()
    const body = opts && typeof opts.body === "string" ? opts.body : ""
    const channelId = channelIdFrom(opts)
    // Unique-per-fire id: there is exactly one capture point (the headless side-channel)
    // and Slack never replays a fired notification, so no dedup target exists — keying on
    // the (coalescing, per-channel) tag would wrongly drop distinct messages.
    const id = `slack:${team || "?"}:${Date.now()}:${seq++}`
    const payload = {
      id,
      source: workspaceName(),
      title: title != null ? String(title) : "",
      body,
      // Channel deep-link is a real SPA route, so reuse the spa-link activate variant —
      // app.tsx activates the owning workspace Tab, then navigateSpa opens the channel.
      activate: channelId ? { type: "spa-link", url: `/client/${team}/${channelId}` } : null,
      ts: Date.now(),
    }
    try {
      window.__cdpNotify(JSON.stringify(payload))
    } catch {
      /* binding not registered (shouldn't happen) */
    }
  }

  // A benign stand-in for the real Notification: capture forwards to CDP Browser, so we
  // deliberately do NOT raise an OS notification on the remote machine. Slack may read
  // back handlers / call close(), so expose a minimal compatible surface.
  function makeStub() {
    const stub = {
      onclick: null,
      onclose: null,
      onerror: null,
      onshow: null,
      close() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false
      },
    }
    return stub
  }

  const Real = window.Notification
  function Patched(title, opts) {
    try {
      capture(title, opts)
    } catch {
      /* never break the page */
    }
    return makeStub()
  }
  // Force permission "granted" so Slack always attempts to fire (the live tab was
  // "default", which would otherwise suppress every notification). Safe — we intercept
  // before anything reaches the OS.
  Object.defineProperty(Patched, "permission", { get: () => "granted", configurable: true })
  Patched.maxActions = Real ? Real.maxActions : 2
  Patched.requestPermission = (cb) => {
    if (typeof cb === "function") cb("granted")
    return Promise.resolve("granted")
  }
  try {
    window.Notification = Patched
  } catch {
    /* non-configurable in some engines — nothing else we can do */
  }

  // Out of scope: notifications raised from inside the service worker's own `push`
  // handler (`self.registration.showNotification`). That runs in the SW global scope — a
  // separate JS realm this page-injected script can't reach (patching the page-realm
  // registration object does nothing to it). In practice the remote Slack tab stays a
  // live page target with the window.Notification hook above active, so Slack's in-page
  // notifications (the steady state) are captured; SW-`push`-only delivery would require
  // attaching a side-channel to the service_worker target and patching within its realm.
})()
