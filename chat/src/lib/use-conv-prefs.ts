import { useCallback, useEffect, useRef, useState } from "react"
import type { ConvPrefs } from "./conversation-view"
import { EMPTY_PREFS } from "./conversation-view"
import { prefsSignature, shouldApplyPoll } from "./prefs-sync"
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

const POLL_INTERVAL_MS = 12_000

/** Conversation prefs (t156): the shared labels/folder/mute map + a per-device folder-collapse set.
 *  Prefs are fetched on boot, re-fetched after each write, and polled every ~12 s so another
 *  device's folder/label/rename/mute change appears without reload (Workstream K, PSN-96).
 *  Collapse state persists per device in server ui-state (localStorage wipes on the iPad PWA). */
export function useConvPrefs() {
  const [prefs, setPrefsState] = useState<Record<string, ConvPrefs>>({})
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [folderOrder, setFolderOrderState] = useState<string[]>([])
  const deviceId = useRef(getDeviceId()).current

  // Refs for grace-window and change-detection inside the poll callback (avoids stale closures).
  const lastLocalWriteAtRef = useRef(0)
  const currentSigRef = useRef<string | null>(null)

  // Apply a fetched prefs payload to state; skips if nothing changed.
  const applyFetched = useCallback(
    (p: { prefs: Record<string, ConvPrefsDto>; folderOrder: string[] }, fromPoll: boolean) => {
      const sig = prefsSignature(p)
      if (
        fromPoll &&
        !shouldApplyPoll(sig, currentSigRef.current ?? "", lastLocalWriteAtRef.current, Date.now())
      )
        return
      currentSigRef.current = sig
      setPrefsState(normalize(p.prefs))
      setFolderOrderState(p.folderOrder)
    },
    [],
  )

  useEffect(() => {
    const ac = new AbortController()

    // Boot fetch (not a poll — always apply).
    fetchPrefs(ac.signal).then((p) => {
      if (!ac.signal.aborted) applyFetched(p, false)
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

    // Poll every ~12 s; pause when hidden, refresh immediately on re-focus.
    const poll = () => {
      if (document.hidden) return
      fetchPrefs(ac.signal)
        .then((p) => {
          if (!ac.signal.aborted) applyFetched(p, true)
        })
        .catch(() => {})
    }
    const timer = setInterval(poll, POLL_INTERVAL_MS)
    const onVisible = () => {
      if (!document.hidden) poll()
    }
    document.addEventListener("visibilitychange", onVisible)

    return () => {
      ac.abort()
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [deviceId, applyFetched])

  // Patch one conversation's prefs: optimistic local update, then POST; the server returns the row's
  // full prefs which we fold back in (authoritative — e.g. sanitized labels).
  const patch = useCallback((convId: string, next: ConvPrefsPatch) => {
    lastLocalWriteAtRef.current = Date.now()
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
    lastLocalWriteAtRef.current = Date.now()
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
