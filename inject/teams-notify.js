// Injected into Teams remote pages (document-start on every load + once immediately on
// attach). Watches Teams' own in-app toast (`[data-testid="notification-wrapper"]`),
// reads its text and the React fiber's `targetEntity`, and ships each one through the
// `__cdpNotify` binding the side-channel registers. Pure capture — never navigates.
//
// Findings this relies on (verified against Edge 148 / Teams v2, 2026-05-23):
//   - toast node carries data-testid="notification-wrapper"
//   - innerText is "<source>\n<title>\n<body>"
//   - aria-labelledby suffix is the *thread* id (cn-normal-notification-main-text-<threadId>)
//   - fiber memoizedProps.targetEntity = {action, type, id, dataOptions:{userContextId, messageId}}
;(() => {
  if (window.__cdpNotifyArmed) return
  window.__cdpNotifyArmed = true

  const SEL = '[data-testid="notification-wrapper"]'
  const seen = new WeakSet()

  const text = (el) => (el ? (el.innerText || el.textContent || "").trim() : "")

  // The thread id lives in the aria-labelledby suffix — used as namespace and fallback id.
  const notifId = (w) => {
    const m = (w.getAttribute("aria-labelledby") || "").match(
      /cn-normal-notification-main-text-(\S+)/,
    )
    return m ? m[1] : null
  }

  // Climb the DOM to a node carrying a React fiber, then climb the fiber tree to the
  // props bearing `targetEntity` (the durable navigation target).
  const targetEntity = (w) => {
    let el = w
    let key = null
    for (let i = 0; i < 6 && el; i++) {
      key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"))
      if (key) break
      el = el.parentElement
    }
    if (!key) return null
    let fiber = el[key]
    for (let lvl = 0; fiber && lvl < 70; lvl++) {
      const p = fiber.memoizedProps
      if (p && p.targetEntity) return p.targetEntity
      fiber = fiber.return
    }
    return null
  }

  const capture = (w) => {
    if (seen.has(w)) return
    seen.add(w)
    const lines = text(w)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
    if (!lines.length) {
      // Empty shell mounted before content — let a later mutation re-capture it.
      seen.delete(w)
      return
    }
    let entity = null
    try {
      entity = targetEntity(w)
    } catch {
      /* fiber shape changed — text capture still useful */
    }
    const raw = notifId(w)
    // The aria-labelledby suffix (`raw`) is the *conversation* thread id — shared by every
    // message in a chat — so it can't be the dedup key, or ingest's id-dedup keeps only the
    // first message per conversation and drops the rest. The durable per-message id is the
    // entity's messageId; key on it (namespaced by thread) so each message comes through once
    // while cross-tab mirrors of the same message still collapse. The "Test notification"
    // button reuses a fixed id, so uniquify it — each click is a distinct event.
    const messageId = entity && entity.dataOptions && entity.dataOptions.messageId
    const id =
      raw === "testNotification"
        ? `testNotification:${Date.now()}`
        : messageId
          ? `${entity?.id ? entity.id : raw || ""}:${messageId}`
          : raw || `${entity?.id ? entity.id : ""}:${lines.join("|")}`
    const payload = {
      id,
      source: lines[0] || "",
      title: lines[1] || "",
      body: lines.slice(2).join(" ") || "",
      targetEntity: entity,
      ts: Date.now(),
    }
    try {
      window.__cdpNotify(JSON.stringify(payload))
    } catch {
      /* binding not registered (shouldn't happen) */
    }
  }

  const scan = () => {
    for (const w of document.querySelectorAll(SEL)) capture(w)
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
