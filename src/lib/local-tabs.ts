/** A locally-rendered tab — a native WebContentsView the main process owns. */
export interface LocalTab {
  id: string
  url: string
  title: string
  favicon?: string
  pinned: boolean
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  audible: boolean
  muted: boolean
}

/** The persisted shape for a local tab (all open local tabs are restored on launch). */
export interface PersistedLocalTab {
  id: string
  url: string
  title: string
  favicon?: string
  pinned: boolean
}

/**
 * Pinned local tabs sit atop the LOCAL TABS section; unpinned below. Stable
 * within each group. Returns the same reference when already ordered so React
 * state doesn't churn needlessly.
 */
export function sortPinnedFirst(tabs: LocalTab[]): LocalTab[] {
  let alreadyOrdered = true
  let seenUnpinned = false
  for (const t of tabs) {
    if (t.pinned && seenUnpinned) {
      alreadyOrdered = false
      break
    }
    if (!t.pinned) seenUnpinned = true
  }
  if (alreadyOrdered) return tabs
  return [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)]
}

/** All open local tabs persist (pinned flag carried); live-only fields dropped. */
export function toPersisted(tabs: LocalTab[]): PersistedLocalTab[] {
  return tabs.map((t) => ({
    id: t.id,
    url: t.url,
    title: t.title,
    favicon: t.favicon,
    pinned: t.pinned,
  }))
}

/** Rehydrate persisted local tabs (preserving pinned) with inert live defaults. */
export function fromPersisted(saved: PersistedLocalTab[]): LocalTab[] {
  return saved.map((s) => ({
    id: s.id,
    url: s.url,
    title: s.title,
    favicon: s.favicon,
    pinned: s.pinned,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    audible: false,
    muted: false,
  }))
}
