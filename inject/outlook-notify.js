// Injected into Outlook (OWA) remote pages (document-start on every load + once
// immediately on attach). Watches OWA's own in-app notification (the NotificationPane
// toast), reads sender/subject/body, extracts the message ItemID from the React fiber
// for a deep-link, and ships each one through the `__cdpNotify` binding the side-channel
// registers. Pure capture — never navigates.
//
// Findings this relies on (verified against Edge 148 / OWA, 2026-05-23):
//   - notification renders into div[data-app-section="NotificationPane"] even when the
//     tab is document.hidden (so background capture works; OWA never uses Notification API)
//   - each item is a button[aria-roledescription="Notification"] with
//     aria-label="New mail from <sender>"
//   - subject lives in .KTZ84, body preview in .mrxI1 (hashed Fluent classes — best-effort;
//     aria attributes are the durable anchors)
//   - the message ItemID (base64 starting AAQk/AAMk) lives in the button's React fiber
//   - deep-link: <origin>/mail/inbox/id/<encodeURIComponent(ItemID)>, opened SPA-side
;(() => {
  if (window.__cdpNotifyArmed) return
  window.__cdpNotifyArmed = true

  const ITEM = "[aria-roledescription='Notification']"
  const ID_RE = /A[AQM][MQ]k[A-Za-z0-9+/=_-]{20,}/
  const seen = new WeakSet()

  const text = (el) => (el ? (el.innerText || el.textContent || "").trim() : "")

  // Sender from "New mail from <sender>", else the first line of the sender block.
  const sender = (btn) => {
    const label = btn.getAttribute("aria-label") || ""
    const m = label.match(/^New mail from\s+(.+)$/i)
    if (m) return m[1].trim()
    const block = btn.querySelector(".ZJg8d > div")
    return text(block)
  }

  // The ItemID lives in the button's fiber props (not the DOM). Walk up to the nearest
  // fiber, then up the tree collecting base64 ids; skip the id already open in the route
  // so we deep-link the notified message, not whatever is on screen.
  const itemId = (btn) => {
    let el = btn
    let key = null
    for (let i = 0; i < 5 && el; i++) {
      key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"))
      if (key) break
      el = el.parentElement
    }
    if (!key) return null
    const openId = decodeURIComponent((location.pathname.match(/\/id\/([^/?#]+)/) || [])[1] || "")
    let fiber = el[key]
    for (let lvl = 0; fiber && lvl < 60; lvl++) {
      const p = fiber.memoizedProps
      if (p && typeof p === "object") {
        for (const k of Object.keys(p)) {
          const v = p[k]
          if (!v || typeof v === "function") continue
          let s
          try {
            s = typeof v === "object" ? JSON.stringify(v) : String(v)
          } catch {
            continue
          }
          const found = s.match(ID_RE)
          if (found && found[0] !== openId) return found[0]
        }
      }
      fiber = fiber.return
    }
    return null
  }

  const capture = (btn) => {
    if (seen.has(btn)) return
    seen.add(btn)
    const source = sender(btn)
    const title = text(btn.querySelector(".KTZ84"))
    const body = text(btn.querySelector(".mrxI1"))
    if (!source && !title) {
      // Empty shell mounted before content — let a later mutation re-capture it.
      seen.delete(btn)
      return
    }
    let id = null
    let deepLink = null
    try {
      const iid = itemId(btn)
      if (iid) {
        id = iid
        deepLink = `${location.origin}/mail/inbox/id/${encodeURIComponent(iid)}`
      }
    } catch {
      /* fiber shape changed — text capture still useful */
    }
    const payload = {
      // No durable ItemID → fall back to content identity (cross-tab/reload safe; no ts).
      id: id || `${source}|${title}|${body}`,
      source,
      title,
      body,
      targetEntity: deepLink ? { deepLink } : null,
      ts: Date.now(),
    }
    try {
      window.__cdpNotify(JSON.stringify(payload))
    } catch {
      /* binding not registered (shouldn't happen) */
    }
  }

  const scan = () => {
    for (const btn of document.querySelectorAll(ITEM)) capture(btn)
  }

  const start = () => {
    const root = document.documentElement
    if (!root) return false
    new MutationObserver(scan).observe(root, { childList: true, subtree: true })
    scan()
    return true
  }

  // document-start injection runs before <html> in rare cases — retry on next tick.
  if (!start()) {
    const t = setInterval(() => start() && clearInterval(t), 50)
  }
})()
