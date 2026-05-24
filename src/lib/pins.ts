// Pin link resolution — pure logic over Pins and the live remote targets.
// A Pin holds a remote tab: `targetId` names the linked target when one is live.
// Effects (opening tabs, persisting, IPC) live in app.tsx / main.js; this module
// only decides links. See docs/adr/0004-pin-live-tab-model.md.

/** The fields of a remote target this module needs to resolve a link. */
export interface LinkTarget {
  id: string
  url: string
}

/**
 * Decide which live target a pin links to, used on startup:
 * 1. the persisted target id, if it's still among the live targets
 * 2. otherwise the first target whose url matches the pin's saved url
 * 3. otherwise none (the pin has no live tab)
 *
 * In-session clicks on an unlinked pin always open a fresh tab and do NOT call
 * this — url-adoption is a startup-only convenience.
 */
export function resolvePinLink(pin: Pin, targets: LinkTarget[]): string | undefined {
  if (pin.targetId && targets.some((t) => t.id === pin.targetId)) return pin.targetId
  return targets.find((t) => t.url === pin.url)?.id
}

/** The pin that owns a given live target, if any — drives Tabs-list filtering. */
export function pinForTarget(pins: Pin[], targetId: string): Pin | undefined {
  return pins.find((p) => p.targetId === targetId)
}

/**
 * Clear `targetId` on any pin whose linked target has vanished from the live set
 * (e.g. closed on the remote browser). Returns the same reference when nothing
 * changed so React can skip re-renders.
 */
export function dropDeadLinks(pins: Pin[], targets: LinkTarget[]): Pin[] {
  const live = new Set(targets.map((t) => t.id))
  let changed = false
  const next = pins.map((p) => {
    if (p.targetId && !live.has(p.targetId)) {
      changed = true
      const { targetId, ...rest } = p
      return rest
    }
    return p
  })
  return changed ? next : pins
}
