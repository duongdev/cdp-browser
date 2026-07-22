import {
  Alert02Icon,
  ArrowLeft01Icon,
  InboxIcon,
  ReloadIcon,
  SentIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { conversationLabel } from "../lib/conversation-view"
import { applyPendingReactions, applyReaction, mergeMessages } from "../lib/message-merge"
import {
  fetchHistory,
  markRead,
  react,
  sendReply,
  TeamsApiError,
  type TeamsConversation,
  type TeamsMessage,
} from "../lib/teams-client"
import { reduceSend, type SendState, selectReplyTarget } from "../lib/teams-reply"
import { MessageRow } from "./message-row"

// Live sync (t113, poll-first): cadence for re-fetching the newest history page while this pane is
// the visible one and the tab is foregrounded.
const THREAD_POLL_MS = 4000
// Stick-to-bottom slack: within this many px of the bottom, a merge that lands newer content
// re-pins to the bottom; farther up we leave scroll alone so we don't yank someone reading history.
const THREAD_BOTTOM_SLACK = 64
// A pending optimistic reaction is overlaid on every merge until the server confirms it, or until it
// ages past this window — a lost write shouldn't pin a phantom reaction forever (t121).
const PENDING_REACTION_TTL_MS = 20000

/** One in-flight optimistic reaction the viewer made: the target `mine` state, the emoji to draw,
 *  and when it was fired (for the failed-write timeout). Keyed msgId → key. */
type PendingReactions = Map<
  string,
  Map<string, { emoji: string; desiredMine: boolean; ts: number }>
>

/** Drop pending entries the server has caught up on, or that have aged out (t121). Mutates in place.
 *  A `(msgId, key)` is confirmed — and its overlay retired so a later real change isn't masked — once
 *  the server page shows that key's `mine` equal to `desiredMine`. Only messages present in the page
 *  can be confirmed; the rest wait for the TTL. */
function reconcilePendingReactions(
  pending: PendingReactions,
  serverMessages: TeamsMessage[],
  now: number,
): void {
  const byId = new Map(serverMessages.map((m) => [m.id, m]))
  for (const [msgId, byKey] of pending) {
    const msg = byId.get(msgId)
    for (const [key, entry] of byKey) {
      if (now - entry.ts > PENDING_REACTION_TTL_MS) {
        byKey.delete(key)
        continue
      }
      if (!msg) continue // not in this page — can't confirm; leave it to the TTL
      const serverMine = msg.reactions?.find((r) => r.key === key)?.mine ?? false
      if (serverMine === entry.desiredMine) byKey.delete(key)
    }
    if (byKey.size === 0) pending.delete(msgId)
  }
}

const errorMessage = (e: unknown): string => {
  if (e instanceof TeamsApiError) {
    if (e.code === "invalid_auth")
      return "Teams sign-in expired — it refreshes when the Teams tab reloads. Retry in a moment."
    if (e.code === "rate_limited") return "Teams is rate-limiting. Try again in a moment."
  }
  return "Could not load messages."
}

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; messages: TeamsMessage[] }

interface ThreadViewProps {
  conversation: TeamsConversation
  /** Back to the list — shown on the phone (stacked), hidden in the wide two-pane. */
  onBack?: () => void
  /** Whether this pane is the on-screen one (t110). Inactive panes stay mounted (fetch + scroll
   *  preserved) but hidden via display:none, so switching conversations is instant. Defaults true. */
  visible?: boolean
}

/** The thread pane (t107, ADR-0018): one conversation's real messages, rendered oldest-first from
 *  server-sanitized ReaderMessages. Four states; scroll-to-top lazily loads an older page. Kept
 *  mounted across conversation switches (t110) — hidden when inactive, never refetched. */
export function ThreadView({ conversation, onBack, visible = true }: ThreadViewProps) {
  const [state, setState] = useState<State>({ status: "loading" })
  // Older-page paging (t112): the server returns an opaque `backwardLink` cursor with each page;
  // null means there is no older page. `hasMore` mirrors "cursor is non-null" for the affordance.
  const [hasMore, setHasMore] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const olderCursor = useRef<string | null>(null)
  const loadingOlderRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Latest scroll offset, tracked live while visible — display:none drops the container's scrollTop,
  // so this ref (not a read at hide-time, which would already be 0) is what we restore on re-show.
  const savedScrollTop = useRef(0)
  // In-flight optimistic reactions, overlaid on every merge until the server confirms (t121). A ref
  // (not state) — mutating it never needs a re-render; the overlay it drives is applied inside the
  // merge setState. Cleared per conversation switch below.
  const pendingReactions = useRef<PendingReactions>(new Map())
  const convId = conversation.id

  const load = useCallback(
    (signal?: AbortSignal) => {
      setState({ status: "loading" })
      setHasMore(true)
      olderCursor.current = null
      pendingReactions.current = new Map() // stale optimistic reactions don't leak across a switch
      fetchHistory(convId)
        .then((page) => {
          if (signal?.aborted) return
          setState({ status: "ready", messages: page.messages })
          olderCursor.current = page.cursor
          setHasMore(page.cursor != null)
        })
        .catch((e) => {
          if (!signal?.aborted) setState({ status: "error", message: errorMessage(e) })
        })
    },
    [convId],
  )

  // Reload whenever the selected conversation changes.
  useEffect(() => {
    const ac = new AbortController()
    load(ac.signal)
    return () => ac.abort()
  }, [load])

  // Reverse-flexbox scroll model: the message list is `flex-col-reverse`, so the browser pins the
  // scroll to the bottom (newest) for free — scrollTop 0 IS the bottom. First render lands there with
  // no manual scroll, prepending older messages at the visual top never shifts the viewport, and new
  // messages stick to the bottom automatically when the user is already there. This removes the whole
  // class of scroll-anchor math (and the load-more jump/flicker it caused).

  const loadOlder = useCallback(() => {
    if (loadingOlderRef.current || !hasMore) return
    const cursor = olderCursor.current
    if (!cursor) return
    if (state.status !== "ready" || state.messages.length === 0) return
    loadingOlderRef.current = true
    setLoadingOlder(true)
    fetchHistory(convId, cursor)
      .then((older) => {
        // Dedup by id (a page boundary can re-emit a message; keep the render idempotent).
        const known = new Set(state.messages.map((m) => m.id))
        const fresh = older.messages.filter((m) => !known.has(m.id))
        olderCursor.current = older.cursor
        setHasMore(older.cursor != null)
        if (fresh.length > 0) {
          // flex-col-reverse pins the viewport to its bottom-distance, so the prepend needs no
          // scroll correction — the read position holds through the insert.
          setState((s) =>
            s.status === "ready"
              ? {
                  status: "ready",
                  messages: applyPendingReactions(
                    [...fresh, ...s.messages],
                    pendingReactions.current,
                  ),
                }
              : s,
          )
        }
      })
      .catch(() => setHasMore(false))
      .finally(() => {
        loadingOlderRef.current = false
        setLoadingOlder(false)
      })
  }, [convId, hasMore, state])

  // Trigger load-older from a sentinel at the visual top (mirrors the list's t114 infinite scroll)
  // rather than a scrollTop threshold — flex-col-reverse makes scrollTop's sign browser-dependent, but
  // an IntersectionObserver on a top sentinel is sign-agnostic. A ref carries the latest loadOlder so
  // the observer rebuilds only when load-ability flips.
  const topSentinelRef = useRef<HTMLDivElement>(null)
  const loadOlderRef = useRef(loadOlder)
  loadOlderRef.current = loadOlder
  const canLoadOlder = state.status === "ready" && hasMore && state.messages.length > 0
  useEffect(() => {
    if (!canLoadOlder) return
    const el = topSentinelRef.current
    const root = scrollRef.current
    if (!el || !root) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadOlderRef.current()
      },
      { root, rootMargin: "300px 0px" },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [canLoadOlder])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (el) savedScrollTop.current = el.scrollTop
  }, [])

  // Restore scroll when this pane becomes visible again (t110). display:none resets the container's
  // scrollTop, so re-showing a kept-alive thread must re-seat it. Keyed on `visible` only: on a fresh
  // mount this restores 0 while still loading, then the status→ready scroll-to-bottom lands at bottom
  // and this won't refire (visible unchanged), so first-load bottom still wins.
  useLayoutEffect(() => {
    if (!visible) return
    const el = scrollRef.current
    if (el) el.scrollTop = savedScrollTop.current
  }, [visible])

  // Poll the newest history page and merge it in (t113). Only touches a "ready" state — a loading/
  // error pane is left to the initial load. Errors are swallowed: a failed poll keeps the last-good
  // thread rather than flipping to error. Sticks to the bottom only if the user was already there.
  const poll = useCallback(() => {
    fetchHistory(convId)
      .then((page) => {
        const el = scrollRef.current
        // flex-col-reverse: the bottom (newest) is scrollTop ≈ 0. Only re-pin if already there.
        const nearBottom = el ? Math.abs(el.scrollTop) < THREAD_BOTTOM_SLACK : false
        // Retire optimistic reactions the server now reflects (or that timed out) BEFORE overlaying,
        // so a confirmed reaction stops being pinned and a later real change isn't masked (t121).
        reconcilePendingReactions(pendingReactions.current, page.messages, Date.now())
        setState((s) => {
          if (s.status !== "ready") return s
          const merged = mergeMessages(s.messages, page.messages)
          // Overlay the still-pending reactions so a stale server page can't revert the optimistic
          // chip. The overlay reuses the same-ref no-op, so a poll that changes nothing re-renders
          // nothing.
          const overlaid = applyPendingReactions(merged.messages, pendingReactions.current)
          return overlaid === s.messages ? s : { status: "ready", messages: overlaid }
        })
        if (nearBottom) {
          requestAnimationFrame(() => {
            const now = scrollRef.current
            if (now) now.scrollTop = 0
          })
        }
      })
      .catch(() => {
        // Poll errors are silent (t113) — the last-good thread stays put.
      })
  }, [convId])

  // Drive the poll off a stable ref so the interval survives a conversation switch (convId change
  // only re-points the ref; `load` already refetches on switch) and doesn't reset every 4s.
  const pollRef = useRef(poll)
  useEffect(() => {
    pollRef.current = poll
  }, [poll])

  // Only the active + visible pane polls, and only while the tab is foregrounded. Becoming visible
  // (or the tab returning to foreground) fires one immediate poll so a switched-back kept-alive
  // thread refreshes at once; going hidden clears the interval.
  useEffect(() => {
    if (!visible) return
    let timer: ReturnType<typeof setInterval> | undefined
    const tick = () => pollRef.current()
    const start = () => {
      if (timer == null) timer = setInterval(tick, THREAD_POLL_MS)
    }
    const stop = () => {
      if (timer != null) {
        clearInterval(timer)
        timer = undefined
      }
    }
    const onVisibility = () => {
      if (document.hidden) stop()
      else {
        tick()
        start()
      }
    }
    if (!document.hidden) {
      tick()
      start()
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      stop()
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [visible])

  // Reactions (t120): the thread owns message state, so it applies the optimistic toggle here
  // (add/remove self + adjust count via the pure applyReaction) and fires the best-effort server
  // call. The optimistic change is also recorded as a pending overlay (t121) so the 4s poll's
  // server-wins merge can't revert it before Teams propagates the reaction; the overlay is retired
  // the moment the server reflects it (reconcilePendingReactions).
  const onReact = useCallback(
    (msgId: string, key: string, emoji: string, remove: boolean) => {
      let byKey = pendingReactions.current.get(msgId)
      if (!byKey) {
        byKey = new Map()
        pendingReactions.current.set(msgId, byKey)
      }
      byKey.set(key, { emoji, desiredMine: !remove, ts: Date.now() })
      setState((s) => {
        if (s.status !== "ready") return s
        return {
          status: "ready",
          messages: s.messages.map((m) =>
            m.id === msgId
              ? { ...m, reactions: applyReaction(m.reactions, key, emoji, remove) }
              : m,
          ),
        }
      })
      react(convId, msgId, key, remove)
    },
    [convId],
  )

  // Composer (t108, Q9 hybrid): text-only, synchronous + honest — no outbox. A successful send
  // optimistically appends the message and write-through marks the conversation read on Teams.
  // The reply target is chosen by the single policy owner (selectReplyTarget) — flat for Teams.
  const replyTarget = selectReplyTarget(conversation)
  const [send, setSend] = useState<SendState>({ phase: "idle", draft: "" })
  const taRef = useRef<HTMLTextAreaElement>(null)
  // Reset the composer when the conversation changes (a half-typed draft doesn't leak across).
  // biome-ignore lint/correctness/useExhaustiveDependencies: convId is the deliberate reset trigger
  useEffect(() => setSend({ phase: "idle", draft: "" }), [convId])
  // Auto-grow the textarea up to a cap; height resets to measure the real scrollHeight each edit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: send.draft is the deliberate re-measure trigger
  useLayoutEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`
  }, [send.draft])

  const doSend = useCallback(() => {
    const text = send.draft.trim()
    const next = reduceSend(send, { type: "send" })
    setSend(next)
    if (next.phase !== "sending" || !replyTarget) return
    sendReply(replyTarget.convId, text)
      .then((out) => {
        setSend((s) => reduceSend(s, { type: "ok" }))
        const sent: TeamsMessage = {
          id: out.ts,
          ts: Number(out.ts) || Date.now(),
          senderId: "",
          senderName: "You",
          body: text,
          self: true,
          edited: false,
          deleted: false,
        }
        setState((s) =>
          s.status === "ready" ? { status: "ready", messages: [...s.messages, sent] } : s,
        )
        requestAnimationFrame(() => {
          const el = scrollRef.current
          if (el) el.scrollTop = 0 // flex-col-reverse: 0 is the bottom (newest)
        })
        // Write-through mark-read (best-effort). For Teams, the message id IS its arrival ts.
        markRead(replyTarget.convId, out.ts, out.ts)
      })
      .catch((e) => {
        const code = e instanceof TeamsApiError ? e.code : "network_error"
        setSend((s) => reduceSend(s, { type: "fail", code }))
      })
  }, [send, replyTarget])

  const composer = (
    <div className="shrink-0 border-border border-t px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      {send.phase === "failed" && (
        <p className="pb-1.5 text-destructive text-xs">{sendErrorCopy(send.code)}</p>
      )}
      <div className="flex items-end gap-2">
        <textarea
          className="max-h-32 min-h-9 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-base outline-none focus:ring-1 focus:ring-ring"
          disabled={send.phase === "sending"}
          onChange={(e) => setSend(reduceSend(send, { type: "edit", draft: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              doSend()
            }
          }}
          placeholder="Type a message…"
          ref={taRef}
          rows={1}
          value={send.draft}
        />
        <Button
          aria-label={send.phase === "failed" ? "Retry send" : "Send"}
          disabled={send.phase === "sending" || !send.draft.trim()}
          onClick={doSend}
          size="icon"
        >
          <HugeiconsIcon className="size-4" icon={SentIcon} />
        </Button>
      </div>
      {send.phase === "sending" && (
        <p className="pt-1 text-[11px] text-muted-foreground">Sending…</p>
      )}
    </div>
  )

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-background", !visible && "hidden")}>
      <header className="flex h-12 shrink-0 items-center gap-1 border-border border-b px-2">
        {onBack && (
          <Button
            aria-label="Back to conversations"
            className="text-muted-foreground"
            onClick={onBack}
            size="icon-sm"
            variant="ghost"
          >
            <HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
          </Button>
        )}
        <span className="min-w-0 flex-1 truncate px-1 font-heading font-semibold text-foreground text-sm">
          {conversationLabel(conversation)}
        </span>
      </header>

      {state.status === "loading" ? (
        <ThreadSkeleton />
      ) : state.status === "error" ? (
        <Centered>
          <HugeiconsIcon className="size-8 text-muted-foreground" icon={Alert02Icon} />
          <p className="max-w-xs text-muted-foreground text-sm">{state.message}</p>
          <Button onClick={() => load()} size="sm" variant="outline">
            <HugeiconsIcon icon={ReloadIcon} />
            Retry
          </Button>
        </Centered>
      ) : (
        <>
          {state.messages.length === 0 ? (
            <Centered>
              <HugeiconsIcon className="size-8 text-muted-foreground" icon={InboxIcon} />
              <p className="text-muted-foreground text-sm">No messages yet</p>
            </Centered>
          ) : (
            <div
              className="flex min-h-0 flex-1 flex-col-reverse gap-2 overflow-y-auto overscroll-contain px-3 py-3"
              onScroll={onScroll}
              ref={scrollRef}
            >
              {/* flex-col-reverse: the FIRST child renders at the visual BOTTOM, so render newest-first
                  to show oldest→newest top→bottom. Older messages prepend to the array (→ end of this
                  reversed map = the visual top), and the loading skeleton + sentinel sit above them. */}
              {state.messages
                .slice()
                .reverse()
                .map((m) => (
                  <MessageRow key={m.id} message={m} onReact={onReact} />
                ))}
              {loadingOlder && [0, 1, 2].map((i) => <MessageBubbleSkeleton index={i} key={i} />)}
              {canLoadOlder && <div className="h-px shrink-0" ref={topSentinelRef} />}
            </div>
          )}
          {replyTarget && composer}
        </>
      )}
    </div>
  )
}

// Composer failure copy — honest and specific where we can be, generic otherwise.
function sendErrorCopy(code: string): string {
  if (code === "invalid_auth")
    return "Teams sign-in expired — it refreshes when the Teams tab reloads. Your message is kept; retry in a moment."
  if (code === "rate_limited")
    return "Teams is rate-limiting. Your message is kept — retry in a moment."
  return "Could not send. Your message is kept — retry."
}

// One placeholder bubble matching ThreadSkeleton's row (label chip + bubble), alternating side by
// index. Shared by the full-screen initial skeleton and the top-of-thread load-older placeholder.
function MessageBubbleSkeleton({ index }: { index: number }) {
  return (
    <div
      className={cn("flex shrink-0 flex-col gap-1", index % 2 === 0 ? "items-start" : "items-end")}
    >
      <div className="h-3 w-16 animate-pulse rounded bg-muted" />
      <div className="h-8 w-2/3 animate-pulse rounded-2xl bg-muted" />
    </div>
  )
}

function ThreadSkeleton() {
  return (
    <div aria-hidden className="flex flex-1 flex-col gap-3 p-3">
      {[0, 1, 2, 3, 4].map((i) => (
        <MessageBubbleSkeleton index={i} key={i} />
      ))}
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      {children}
    </div>
  )
}
