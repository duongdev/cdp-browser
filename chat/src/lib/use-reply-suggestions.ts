// Reply-suggestions controller (ADR-0027, PSN-143). Owns the batch + request lifecycle for one
// conversation so two components can share it: the strip renders the batch, and the composer
// toolbar renders the generate button next to Send.
//
// It never sends. Choosing a suggestion inserts text into the composer and records the pick; the
// user presses Send himself (ADR-0027 decision 6).

import { useCallback, useEffect, useRef, useState } from "react"
import {
  chooseSuggestion,
  dismissSuggestions,
  fetchSuggestions,
  type ReplySuggestionBatch,
} from "./chat-client"
import { useChatWs, useChatWsFrames } from "./chat-ws-context"

/** How long to wait for a producer to answer before saying nobody is home. Generous: the agent runs
 *  an LLM call, which is seconds. Too short and a working setup looks broken. */
export const SUGGEST_TIMEOUT_MS = 30_000

export interface ReplySuggestions {
  batch: ReplySuggestionBatch | null
  pending: boolean
  error: string | null
  /** Ask a producer for a batch. `regenerate` tells it the last one was not good enough. */
  generate: (regenerate: boolean) => void
  /** Stop waiting on the in-flight request. Local only — the request is already on the wire and a
   *  producer may still answer it, in which case the batch arrives and is shown. This clears the
   *  spinner so the user is not stuck watching one for the full timeout. */
  cancel: () => void
  /** Record the pick and hand the text back for insertion. Returns null for an out-of-range idx. */
  choose: (idx: number) => string | null
  dismiss: () => void
}

export function useReplySuggestions(convId: string): ReplySuggestions {
  const [batch, setBatch] = useState<ReplySuggestionBatch | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { requestSuggestions } = useChatWs()

  const clearPending = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = null
    setPending(false)
  }, [])
  // The frame handler must not re-subscribe every render, so it reaches `clearPending` by ref.
  const clearPendingRef = useRef(clearPending)
  clearPendingRef.current = clearPending

  useChatWsFrames((frame) => {
    if (frame.type !== "reply-suggestions" || frame.convId !== convId) return
    setBatch(frame.batch)
    clearPendingRef.current()
    setError(null)
  })

  // Hydrate on conversation change: the WS carries deltas only, so a batch written before this
  // thread was opened is invisible without a read.
  useEffect(() => {
    const ac = new AbortController()
    setBatch(null)
    setError(null)
    fetchSuggestions(convId, ac.signal)
      .then(setBatch)
      .catch(() => {
        // A failed hydrate is not worth a banner — the strip stays empty, the button still works.
      })
    return () => ac.abort()
  }, [convId])

  useEffect(() => clearPending, [clearPending])

  const generate = useCallback(
    (regenerate: boolean) => {
      setError(null)
      if (!requestSuggestions(convId, regenerate)) {
        setError("Not connected — suggestions need a live connection.")
        return
      }
      setPending(true)
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      // Without this the button spins forever when no producer is attached (agent down), which
      // reads as "working" when nothing is.
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null
        setPending(false)
        setError("No producer answered. Is the agent running?")
      }, SUGGEST_TIMEOUT_MS)
    },
    [convId, requestSuggestions],
  )

  const choose = useCallback(
    (idx: number) => {
      const text = batch?.texts[idx]
      if (!batch || text === undefined) return null
      // Bookkeeping is fire-and-forget: the caller already has the text, and a failed POST must not
      // cost the user his insert.
      chooseSuggestion(batch.id, idx)
        .then((r) => setBatch(r.batch))
        .catch(() => {})
      return text
    },
    [batch],
  )

  const cancel = useCallback(() => {
    clearPending()
    setError(null)
  }, [clearPending])

  const dismiss = useCallback(() => {
    if (!batch) return
    const id = batch.id
    setBatch(null)
    dismissSuggestions(id).catch(() => {})
  }, [batch])

  return { batch, pending, error, generate, cancel, choose, dismiss }
}
