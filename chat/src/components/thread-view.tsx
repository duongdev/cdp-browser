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
import { mergeMessages } from "../lib/message-merge"
import {
  fetchHistory,
  markRead,
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
  const convId = conversation.id

  const load = useCallback(
    (signal?: AbortSignal) => {
      setState({ status: "loading" })
      setHasMore(true)
      olderCursor.current = null
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

  // Land at the bottom (newest) on first ready render. Keyed on convId + status only: older-page
  // prepends keep status "ready" so this won't refire and yank the viewport (they self-manage).
  // biome-ignore lint/correctness/useExhaustiveDependencies: convId + status are the deliberate keys
  useLayoutEffect(() => {
    if (state.status === "ready" && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [convId, state.status])

  const loadOlder = useCallback(() => {
    if (loadingOlderRef.current || !hasMore) return
    const cursor = olderCursor.current
    if (!cursor) return
    if (state.status !== "ready" || state.messages.length === 0) return
    const el = scrollRef.current
    if (!el) return
    loadingOlderRef.current = true
    setLoadingOlder(true)
    const prevHeight = el.scrollHeight
    fetchHistory(convId, cursor)
      .then((older) => {
        // Dedup by id (a page boundary can re-emit a message; keep the render idempotent).
        const known = new Set(state.messages.map((m) => m.id))
        const fresh = older.messages.filter((m) => !known.has(m.id))
        olderCursor.current = older.cursor
        setHasMore(older.cursor != null)
        if (fresh.length > 0) {
          setState((s) =>
            s.status === "ready" ? { status: "ready", messages: [...fresh, ...s.messages] } : s,
          )
          // Preserve the viewport: keep the same message under the user's eye after the prepend.
          requestAnimationFrame(() => {
            const now = scrollRef.current
            if (now) now.scrollTop += now.scrollHeight - prevHeight
          })
        }
      })
      .catch(() => setHasMore(false))
      .finally(() => {
        loadingOlderRef.current = false
        setLoadingOlder(false)
      })
  }, [convId, hasMore, state])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    savedScrollTop.current = el.scrollTop
    if (el.scrollTop < 48) loadOlder()
  }, [loadOlder])

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
        const nearBottom = el
          ? el.scrollHeight - el.scrollTop - el.clientHeight < THREAD_BOTTOM_SLACK
          : false
        setState((s) => {
          if (s.status !== "ready") return s
          const merged = mergeMessages(s.messages, page.messages)
          return merged.changed ? { status: "ready", messages: merged.messages } : s
        })
        if (nearBottom) {
          requestAnimationFrame(() => {
            const now = scrollRef.current
            if (now) now.scrollTop = now.scrollHeight
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
          if (el) el.scrollTop = el.scrollHeight
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
              className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-3 py-3"
              onScroll={onScroll}
              ref={scrollRef}
            >
              {loadingOlder && (
                <p className="shrink-0 py-1 text-center text-[11px] text-muted-foreground">
                  Loading older…
                </p>
              )}
              {state.messages.map((m) => (
                <MessageRow key={m.id} message={m} />
              ))}
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

function ThreadSkeleton() {
  return (
    <div aria-hidden className="flex flex-1 flex-col gap-3 p-3">
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          className={
            i % 2 === 0 ? "flex flex-col items-start gap-1" : "flex flex-col items-end gap-1"
          }
          key={i}
        >
          <div className="h-3 w-16 animate-pulse rounded bg-muted" />
          <div className="h-8 w-2/3 animate-pulse rounded-2xl bg-muted" />
        </div>
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
