import { useCallback, useEffect, useRef, useState } from "react"
import type { ConvPrefs } from "./conversation-view"
import { EMPTY_PREFS } from "./conversation-view"
import { type ConvPrefsDto, fetchPrefs, setPrefs } from "./teams-client"

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
  const deviceId = useRef(getDeviceId()).current

  useEffect(() => {
    const ac = new AbortController()
    fetchPrefs(ac.signal).then((p) => {
      if (!ac.signal.aborted) setPrefsState(normalize(p))
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
  const patch = useCallback(
    (convId: string, next: { labels?: string[]; folder?: string | null; muted?: boolean }) => {
      setPrefsState((m) => ({ ...m, [convId]: applyPatch(m[convId], next) }))
      setPrefs(convId, next).then((row) => {
        if (row) setPrefsState((m) => ({ ...m, [convId]: fromDto(row) }))
      })
    },
    [],
  )

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

  return { prefs, patch, collapsed, toggleFolderCollapsed }
}

function normalize(p: Record<string, ConvPrefsDto>): Record<string, ConvPrefs> {
  const out: Record<string, ConvPrefs> = {}
  for (const [id, v] of Object.entries(p)) out[id] = fromDto(v)
  return out
}

function fromDto(v: ConvPrefsDto): ConvPrefs {
  return { labels: v.labels ?? [], folder: v.folder ?? null, muted: !!v.muted }
}

function applyPatch(
  cur: ConvPrefs | undefined,
  next: { labels?: string[]; folder?: string | null; muted?: boolean },
): ConvPrefs {
  const base = cur ?? EMPTY_PREFS
  return {
    labels: next.labels ?? base.labels,
    folder: next.folder !== undefined ? next.folder : base.folder,
    muted: next.muted !== undefined ? next.muted : base.muted,
  }
}
