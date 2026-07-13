// Dedicated notification capture tab — pure planner (t105, ADR-0018).
//
// Some notification adapters (Teams) suppress their in-app toast for the conversation
// a tab has open + focused. The side-channel scrapes that toast, so a message in the
// actively-viewed conversation is never captured. Fix: keep one adapter tab that is
// ALWAYS background (never focused, no conversation "active"), so the app fires the
// toast for every message including the open one. That tab is marked with
// `window.name === CAPTURE_MARKER` (survives a reload; a URL marker does not — Teams
// normalizes it away), which any client can read over its side-channel socket.
//
// This module only decides create/reap from the current target picture; the effectful
// create (background `Target.createTarget` + marker set) and close live in the backend.
// Verified live (2026-07-13): a hidden Teams tab renders the toast the focused tab drops,
// and Teams v2 does not park a second concurrent tab. Pure — tested by capture-tab.test.ts.

const CAPTURE_MARKER = "__cdpCaptureTab"

// Decide which capture tabs to open or reap.
//   adapterTabs     — [{ id, adapter }] page targets matching a capture-tab adapter
//   isMarked        — (id) => boolean, true when a target carries CAPTURE_MARKER
//   captureAdapters — [{ name, url }] adapters that want a capture tab (Teams today)
// Returns { create: [{ adapter, url }], reap: [id] }.
//
// Per adapter:
//   - no USABLE (non-marked) tab  → the user isn't using this app; reap any lone capture tab
//   - a usable tab but no capture  → open one
//   - more than one capture tab    → reap the extras (multi-client race self-heals)
// Creation is cooldown-gated by the caller so a freshly-created (not-yet-marked) tab
// doesn't trigger a second create before its marker is observed.
function planCaptureTabs(adapterTabs, isMarked, captureAdapters) {
  const create = []
  const reap = []
  for (const { name, url } of captureAdapters || []) {
    const tabs = (adapterTabs || []).filter((t) => t.adapter === name)
    const captures = tabs.filter((t) => isMarked(t.id))
    const usable = tabs.filter((t) => !isMarked(t.id))
    if (usable.length === 0) {
      for (const c of captures) reap.push(c.id)
      continue
    }
    if (captures.length === 0) create.push({ adapter: name, url })
    else if (captures.length > 1) for (const c of captures.slice(1)) reap.push(c.id)
  }
  return { create, reap }
}

module.exports = { planCaptureTabs, CAPTURE_MARKER }
