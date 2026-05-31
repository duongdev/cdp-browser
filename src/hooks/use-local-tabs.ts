/**
 * useLocalTabs — the structural gate for the local-tabs feature.
 *
 * Local <webview> tabs are Electron-only (a real Electron session; see ADR-0005).
 * On the web build there is no such session, so this hook is the single data source
 * that the local-tab feature flows through. When `caps.localTabs` is false it returns
 * a frozen empty list + no-op handlers, so `app.tsx` physically cannot drive any
 * local-tab logic on web — the sidebar receives `[]`, `LocalWebviews` never mounts,
 * the kind toggle is hidden, and Cmd+T/Cmd+Shift+T fall through to CDP.
 *
 * The gate lives here, at the source — not at every consumer. See
 * docs/conventions/feature-gates.md. Under Electron the hook owns the local-tab
 * state cluster relocated out of app.tsx; behavior is byte-for-byte identical.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import type { TabInfo } from "@/app"
import type { LocalApi } from "@/components/local-webviews"
import { type ActiveRef, dropActive } from "@/lib/active-order"
import { getCaps, type WebCaps } from "@/lib/caps"
import type { ClosedStack } from "@/lib/closed-tabs"
import {
  fromPersisted,
  type LocalTab,
  type PersistedLocalTab,
  sortPinnedFirst,
  toPersisted,
} from "@/lib/local-tabs"
import { pinForTarget } from "@/lib/pins"
import { planClose, planSwitch } from "@/lib/tab-lifecycle"

export type ActiveKind = "cdp" | "local"

/**
 * Cross-kind state + local-tab refs app.tsx owns. The refs are created in app.tsx
 * (same scope, so they stay stable for its callbacks) and synced by this hook; the
 * handlers read them (never copies) so close/switch fallback resolves against the
 * live world. On web the hook never writes them, so they hold their empty defaults.
 */
export interface UseLocalTabsDeps {
  tabsRef: React.RefObject<TabInfo[]>
  pinsRef: React.RefObject<Pin[]>
  activeOrderRef: React.RefObject<ActiveRef[]>
  closedTabsRef: React.RefObject<ClosedStack>
  /** Live local-tab list for the CDP close/switch planners (callback freshness). */
  localTabsRef: React.RefObject<LocalTab[]>
  localActiveIdRef: React.RefObject<string | null>
  activeKindRef: React.RefObject<ActiveKind>
  localApiRef: React.RefObject<LocalApi | null>
  /** Late-bound creator the one-time onOpenUrl listener calls (latest impl). */
  createLocalTabRef: React.RefObject<((url?: string) => Promise<string>) | null>
  /** Activate a CDP tab (close/switch fallback may land on a CDP surface). */
  switchTab: (tabId: string) => void
  /** Test seam — production reads `window.webCaps` via the default. */
  getCaps?: () => WebCaps
}

export interface UseLocalTabs {
  localTabs: LocalTab[]
  localActiveId: string | null
  activeLocalTab: LocalTab | null
  activeKind: ActiveKind
  /** Activate the CDP surface (app.tsx's switchTab routes here on switch). */
  setActiveKindCdp: () => void
  createLocalTab: (rawUrl?: string, opts?: { pinned?: boolean }) => Promise<string>
  closeLocalTab: (id: string) => void
  switchLocalTab: (id: string) => void
  patchLocalTab: (id: string, patch: Partial<LocalTab>) => void
  toggleLocalPin: (id: string) => void
  reorderLocalTabs: (reordered: LocalTab[]) => void
  handleEditLocalSave: (id: string, title: string, nextUrl: string) => void
  /** Local pinned tabs surfaced as quick-launch entries in the New-tab dialog. */
  localQuickLaunch: Pin[]
  /** Restore saved local tabs once on launch (called after UI state resolves). */
  restoreLocalTabs: (restore: boolean) => void
}

/** The pure gate decision: local tabs are live only when the capability is present. */
export function isLocalTabsEnabled(caps: WebCaps): boolean {
  return caps.localTabs
}

// Module-level frozen no-op surface so web consumers never re-subscribe between
// renders (stable references). The data is empty, so every seam is inert at the
// source — even a consumer that forgot to check caps gets nothing to drive.
const NOOP = () => {}
const ASYNC_NOOP = async () => ""

/** The frozen empty/no-op surface the hook returns when local tabs are off (web). */
export const EMPTY_LOCAL_TABS: UseLocalTabs = Object.freeze({
  localTabs: [],
  localActiveId: null,
  activeLocalTab: null,
  activeKind: "cdp",
  setActiveKindCdp: NOOP,
  createLocalTab: ASYNC_NOOP,
  closeLocalTab: NOOP,
  switchLocalTab: NOOP,
  patchLocalTab: NOOP,
  toggleLocalPin: NOOP,
  reorderLocalTabs: NOOP,
  handleEditLocalSave: NOOP,
  localQuickLaunch: [],
  restoreLocalTabs: NOOP,
})

export function useLocalTabs(deps: UseLocalTabsDeps): UseLocalTabs {
  const {
    tabsRef,
    pinsRef,
    activeOrderRef,
    closedTabsRef,
    localTabsRef,
    localActiveIdRef,
    activeKindRef,
    localApiRef,
    createLocalTabRef,
    switchTab,
  } = deps
  const enabled = isLocalTabsEnabled((deps.getCaps ?? getCaps)())

  const [localTabs, setLocalTabs] = useState<LocalTab[]>([])
  const [localActiveId, setLocalActiveId] = useState<string | null>(null)
  const [activeKind, setActiveKind] = useState<ActiveKind>("cdp")

  const activeLocalTab = useMemo(
    () => localTabs.find((t) => t.id === localActiveId) ?? null,
    [localTabs, localActiveId],
  )

  // All open local tabs are saved on every list change (restored on launch).
  const persistLocalPins = useCallback((next: LocalTab[]) => {
    window.local.savePins(toPersisted(next) as PersistedLocalTab[])
  }, [])

  const setLocalTabsAnd = useCallback(
    (updater: (prev: LocalTab[]) => LocalTab[]) => {
      setLocalTabs((prev) => {
        const next = sortPinnedFirst(updater(prev))
        localTabsRef.current = next
        persistLocalPins(next)
        return next
      })
    },
    [persistLocalPins, localTabsRef],
  )

  const switchLocalTab = useCallback(
    (id: string) => {
      setActiveKind("local")
      activeOrderRef.current = planSwitch(activeOrderRef.current, { kind: "local", id })
      setLocalActiveId(id)
    },
    [activeOrderRef],
  )

  const createLocalTab = useCallback(
    async (rawUrl?: string, opts?: { pinned?: boolean }) => {
      let u = rawUrl || "https://www.google.com"
      // Only assume https for a bare domain — keep real schemes (chrome-extension://, etc.).
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = `https://${u}`
      const id = crypto.randomUUID()
      const tab: LocalTab = {
        id,
        url: u,
        title: u,
        pinned: opts?.pinned ?? false,
        loading: true,
        canGoBack: false,
        canGoForward: false,
        audible: false,
        muted: false,
      }
      setLocalTabsAnd((prev) => [...prev, tab])
      switchLocalTab(id)
      return id
    },
    [setLocalTabsAnd, switchLocalTab],
  )

  const closeLocalTab = useCallback(
    (id: string) => {
      const tab = localTabsRef.current.find((t) => t.id === id)
      const wasActive = localActiveIdRef.current === id
      const remaining = localTabsRef.current.filter((t) => t.id !== id)
      setLocalTabsAnd(() => remaining)
      const directive = planClose({
        kind: "local",
        id,
        url: tab?.url ?? "",
        wasActive,
        order: activeOrderRef.current,
        tabs: tabsRef.current.filter((t) => !pinForTarget(pinsRef.current, t.id)),
        locals: remaining,
        pins: pinsRef.current,
      })
      if (tab?.url) closedTabsRef.current.push(directive.closedEntry)
      activeOrderRef.current = dropActive(activeOrderRef.current, { kind: "local", id })
      if (wasActive) {
        if (directive.nextActive?.kind === "local") switchLocalTab(directive.nextActive.id)
        else if (directive.nextActive?.kind === "cdp") switchTab(directive.nextActive.id)
        else if (directive.clearActive) {
          setLocalActiveId(null)
          setActiveKind("cdp")
        }
      }
    },
    [
      setLocalTabsAnd,
      switchLocalTab,
      switchTab,
      activeOrderRef,
      tabsRef,
      pinsRef,
      closedTabsRef,
      localTabsRef,
      localActiveIdRef,
    ],
  )

  // Apply a live update from a webview event (title/favicon/loading/nav/audio).
  const patchLocalTab = useCallback(
    (id: string, patch: Partial<LocalTab>) => {
      setLocalTabs((prev) => {
        const next = prev.map((t) => (t.id === id ? { ...t, ...patch } : t))
        localTabsRef.current = next
        return next
      })
    },
    [localTabsRef],
  )

  const toggleLocalPin = useCallback(
    (id: string) => {
      setLocalTabsAnd((prev) => prev.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)))
    },
    [setLocalTabsAnd],
  )

  const reorderLocalTabs = useCallback(
    (reordered: LocalTab[]) => setLocalTabsAnd(() => reordered),
    [setLocalTabsAnd],
  )

  const handleEditLocalSave = useCallback(
    (id: string, title: string, nextUrl: string) => {
      const current = localTabsRef.current.find((t) => t.id === id)
      setLocalTabsAnd((prev) => prev.map((t) => (t.id === id ? { ...t, title, url: nextUrl } : t)))
      if (current && current.url !== nextUrl) localApiRef.current?.navigate(id, nextUrl)
    },
    [setLocalTabsAnd, localTabsRef, localApiRef],
  )

  const setActiveKindCdp = useCallback(() => setActiveKind("cdp"), [])

  const restoreLocalTabs = useCallback(
    (restore: boolean) => {
      if (!restore) return
      window.local.getPins().then((saved: PersistedLocalTab[]) => {
        const restored = sortPinnedFirst(fromPersisted(saved))
        localTabsRef.current = restored
        setLocalTabs(restored)
      })
    },
    [localTabsRef],
  )

  const localQuickLaunch = useMemo<Pin[]>(
    () =>
      localTabs
        .filter((t) => t.pinned)
        .map((t) => ({ id: t.id, title: t.title, url: t.url, favicon: t.favicon })),
    [localTabs],
  )

  // Keep the app.tsx-owned refs in sync (mirrors app.tsx's prior inline effects).
  useEffect(() => {
    localActiveIdRef.current = localActiveId
  }, [localActiveId, localActiveIdRef])
  useEffect(() => {
    activeKindRef.current = activeKind
  }, [activeKind, activeKindRef])
  useEffect(() => {
    // On web the ref stays null so the late-bound creator is inert at the source.
    createLocalTabRef.current = enabled ? createLocalTab : null
  }, [createLocalTab, enabled, createLocalTabRef])

  // The gate: on web the local data never exists, so every seam is inert at the
  // source. Hooks above still run (rules of hooks), but their state stays empty
  // and the returned surface is the frozen no-op one. The deps refs keep their
  // app.tsx defaults ("cdp" / null / []), so app.tsx's callbacks see no local data.
  if (!enabled) return EMPTY_LOCAL_TABS

  return {
    localTabs,
    localActiveId,
    activeLocalTab,
    activeKind,
    setActiveKindCdp,
    createLocalTab,
    closeLocalTab,
    switchLocalTab,
    patchLocalTab,
    toggleLocalPin,
    reorderLocalTabs,
    handleEditLocalSave,
    localQuickLaunch,
    restoreLocalTabs,
  }
}
