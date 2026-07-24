import { useCallback, useEffect, useRef, useState } from "react"
import type { ConvPrefs } from "./conversation-view"
import { EMPTY_PREFS } from "./conversation-view"
import { type ConvPrefsDto, fetchPrefs, setFolderOrder, setPrefs } from "./teams-client"

// Reuse the / build's device identity so folder-collapse state is per-device (like chat settings,
// t154). Prefs THEMSELVES are shared server-side; only the collapse view-state is device-local.
function getDeviceId(): string {
  const key = "cdp_device_id"
  try {
    let id = localStorage.getItem(key)
    if (!id) {
      id = `device_${Math.random().toString(36).slice(2, 9)}_${Date.now()}`
      localStorage.setItem(key, id)
    }
    return id
  } catch {
    return `device_session_${Math.random().toString(36).slice(2, 9)}`
  }
}

const collapseKey = (deviceId: string) => `chatFolders_${deviceId}`

/** Conversation prefs (t156): the shared labels/folder/mute map + a per-device folder-collapse set.
 *  Prefs are fetched once on boot and re-fetched after each write (the server is the source of
 *  truth); a write is optimistic so the UI reacts instantly. Collapse state persists per device in
 *  server ui-state (localStorage wipes on the iPad PWA). */
export function useConvPrefs() {
  const [prefs, setPrefsState] = useState<Record<string, ConvPrefs>>({})
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [folderOrder, setFolderOrderState] = useState<string[]>([])
  const deviceId = useRef(getDeviceId()).current

  useEffect(() => {
    const ac = new AbortController()
    fetchPrefs(ac.signal).then((p) => {
      if (!ac.signal.aborted) {
        setPrefsState(normalize(p.prefs))
        setFolderOrderState(p.folderOrder)
      }
    })
    // Collapse state from ui-state.
    fetch("/api/ui-state")
      .then((r) => (r.ok ? r.json() : {}))
      .then((ui) => {
        if (ac.signal.aborted) return
        const raw = (ui as Record<string, unknown>)[collapseKey(deviceId)]
        if (Array.isArray(raw))
          setCollapsed(new Set(raw.filter((x): x is string => typeof x === "string")))
      })
      .catch(() => {})
    return () => ac.abort()
  }, [deviceId])

  // Patch one conversation's prefs: optimistic local update, then POST; the server returns the row's
  // full prefs which we fold back in (authoritative — e.g. sanitized labels).
  const patch = useCallback((convId: string, next: ConvPrefsPatch) => {
    setPrefsState((m) => ({ ...m, [convId]: applyPatch(m[convId], next) }))
    setPrefs(convId, next).then((row) => {
      if (row) setPrefsState((m) => ({ ...m, [convId]: fromDto(row) }))
    })
  }, [])

  const toggleFolderCollapsed = useCallback(
    (folder: string) => {
      setCollapsed((s) => {
        const next = new Set(s)
        if (next.has(folder)) next.delete(folder)
        else next.add(folder)
        fetch("/api/ui-state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [collapseKey(deviceId)]: [...next] }),
        }).catch(() => {})
        return next
      })
    },
    [deviceId],
  )

  const updateFolderOrder = useCallback((order: string[]) => {
    setFolderOrderState(order)
    setFolderOrder(order) // best-effort POST, swallowed on error
  }, [])

  return {
    prefs,
    patch,
    collapsed,
    toggleFolderCollapsed,
    folderOrder,
    setFolderOrder: updateFolderOrder,
  }
}

function normalize(p: Record<string, ConvPrefsDto>): Record<string, ConvPrefs> {
  const out: Record<string, ConvPrefs> = {}
  for (const [id, v] of Object.entries(p)) out[id] = fromDto(v)
  return out
}

/** The patch shape a mute/label/folder/rename write sends (t156/t167/t168). */
export interface ConvPrefsPatch {
  labels?: string[]
  folder?: string | null
  muted?: boolean
  mutedUntil?: number | null
  notifyOnMention?: boolean
  customTitle?: string | null
}

function fromDto(v: ConvPrefsDto): ConvPrefs {
  return {
    labels: v.labels ?? [],
    folder: v.folder ?? null,
    muted: !!v.muted,
    mutedUntil: v.mutedUntil ?? null,
    notifyOnMention: !!v.notifyOnMention,
    customTitle: v.customTitle ?? null,
  }
}

function applyPatch(cur: ConvPrefs | undefined, next: ConvPrefsPatch): ConvPrefs {
  const base = cur ?? EMPTY_PREFS
  return {
    labels: next.labels ?? base.labels,
    folder: next.folder !== undefined ? next.folder : base.folder,
    muted: next.muted !== undefined ? next.muted : base.muted,
    // Mirror the server rule (t167): a muted write without an expiry clears any stale window.
    mutedUntil:
      next.muted !== undefined
        ? (next.mutedUntil ?? null)
        : next.mutedUntil !== undefined
          ? next.mutedUntil
          : (base.mutedUntil ?? null),
    notifyOnMention:
      next.notifyOnMention !== undefined ? next.notifyOnMention : !!base.notifyOnMention,
    customTitle:
      next.customTitle !== undefined
        ? next.customTitle?.trim() || null
        : (base.customTitle ?? null),
  }
}
