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
import { conversationLabel } from "../lib/conversation-view"
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
}

/** The thread pane (t107, ADR-0018): one conversation's real messages, rendered oldest-first from
 *  server-sanitized ReaderMessages. Four states; scroll-to-top lazily loads an older page. */
export function ThreadView({ conversation, onBack }: ThreadViewProps) {
  const [state, setState] = useState<State>({ status: "loading" })
  // Older-page paging: false once a page comes back short (no more history above).
  const [hasMore, setHasMore] = useState(true)
  const loadingOlderRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const convId = conversation.id

  const load = useCallback(
    (signal?: AbortSignal) => {
      setState({ status: "loading" })
      setHasMore(true)
      fetchHistory(convId)
        .then((messages) => {
          if (signal?.aborted) return
          setState({ status: "ready", messages })
          setHasMore(messages.length >= PAGE_SIZE)
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
    if (state.status !== "ready" || state.messages.length === 0) return
    const el = scrollRef.current
    if (!el) return
    loadingOlderRef.current = true
    const oldest = state.messages[0].ts
    const prevHeight = el.scrollHeight
    fetchHistory(convId, oldest)
      .then((older) => {
        // Drop overlap (the cursor is exclusive server-side, but be defensive).
        const known = new Set(state.messages.map((m) => m.id))
        const fresh = older.filter((m) => !known.has(m.id))
        setHasMore(older.length >= PAGE_SIZE)
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
      })
  }, [convId, hasMore, state])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (el && el.scrollTop < 48) loadOlder()
  }, [loadOlder])

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
    <div className="flex h-full min-h-0 flex-col bg-background">
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

// The server page size (mirrors POST /api/teams/history pageSize=30) — a full page implies more.
const PAGE_SIZE = 30

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
