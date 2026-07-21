import { Alert02Icon, InboxIcon, ReloadIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { mergeConversations } from "../lib/conversation-merge"
import { fetchConversations, TeamsApiError, type TeamsConversation } from "../lib/teams-client"
import { ConversationRow } from "./conversation-row"

// Live sync (t113, poll-first): cadence for re-unioning the newest conversation page.
const LIST_POLL_MS = 12_000

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; conversations: TeamsConversation[]; cursor: string | null }

const errorMessage = (e: unknown): string => {
  if (e instanceof TeamsApiError) {
    if (e.code === "invalid_auth") return "Teams sign-in needed. Open Teams on the remote browser."
    if (e.code === "rate_limited") return "Teams is rate-limiting. Try again in a moment."
  }
  return "Could not load conversations."
}

interface ConversationListProps {
  onOpenConversation: (conversation: TeamsConversation) => void
  /** The open conversation, highlighted in the wide two-pane; null on the phone (stacked). */
  selectedId?: string | null
}

/** The conversation list — loads `POST /api/teams/conversations` (first page), covers all four
 *  states, and pages older via a "Load more" affordance driven by the backwardLink cursor (t112). */
export function ConversationList({ onOpenConversation, selectedId }: ConversationListProps) {
  const [state, setState] = useState<State>({ status: "loading" })
  // Older-page paging (t112): true while a "Load more" fetch is in flight (dedup guard + affordance).
  const [loadingMore, setLoadingMore] = useState(false)
  const loadingMoreRef = useRef(false)

  const load = useCallback((signal?: AbortSignal) => {
    setState({ status: "loading" })
    fetchConversations(undefined, signal)
      .then((page) => {
        if (!signal?.aborted)
          setState({ status: "ready", conversations: page.conversations, cursor: page.cursor })
      })
      .catch((e) => {
        if (signal?.aborted) return
        setState({ status: "error", message: errorMessage(e) })
      })
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    load(ac.signal)
    return () => ac.abort()
  }, [load])

  // Re-union page 1 into the list without disturbing the paging cursor / Load-more state (t113).
  // No-ops unless "ready"; mergeConversations returns the same ref when nothing changed, so we skip
  // the setState (and its re-render) then. Errors are swallowed — a failed refresh keeps the list.
  const refresh = useCallback(() => {
    fetchConversations()
      .then((page) => {
        setState((s) => {
          if (s.status !== "ready") return s
          const merged = mergeConversations(s.conversations, page.conversations)
          return merged === s.conversations ? s : { ...s, conversations: merged }
        })
      })
      .catch(() => {
        // Silent (t113) — the last-good list stays put.
      })
  }, [])

  // Refresh on a cadence + on the tab returning to foreground / window focus. Paused while hidden.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const start = () => {
      if (timer == null) timer = setInterval(refresh, LIST_POLL_MS)
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
        refresh()
        start()
      }
    }
    const onFocus = () => refresh()
    if (!document.hidden) start()
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("focus", onFocus)
    return () => {
      stop()
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("focus", onFocus)
    }
  }, [refresh])

  const loadMore = useCallback(() => {
    if (loadingMoreRef.current) return
    if (state.status !== "ready" || !state.cursor) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    fetchConversations(state.cursor)
      .then((page) => {
        setState((s) => {
          if (s.status !== "ready") return s
          const known = new Set(s.conversations.map((c) => c.id))
          const fresh = page.conversations.filter((c) => !known.has(c.id))
          return {
            status: "ready",
            conversations: [...s.conversations, ...fresh],
            cursor: page.cursor,
          }
        })
      })
      // Stop offering "Load more" if a page fetch fails — the affordance hides on a null cursor.
      .catch(() => setState((s) => (s.status === "ready" ? { ...s, cursor: null } : s)))
      .finally(() => {
        loadingMoreRef.current = false
        setLoadingMore(false)
      })
  }, [state])

  if (state.status === "loading") return <ListSkeleton />

  if (state.status === "error") {
    return (
      <EmptyState icon={Alert02Icon} title={state.message}>
        <Button onClick={() => load()} size="sm" variant="outline">
          <HugeiconsIcon icon={ReloadIcon} />
          Retry
        </Button>
      </EmptyState>
    )
  }

  if (state.conversations.length === 0) {
    return <EmptyState icon={InboxIcon} title="No conversations" />
  }

  return (
    <div className="flex flex-col gap-0.5 p-2">
      {state.conversations.map((c) => (
        <ConversationRow
          active={c.id === selectedId}
          conversation={c}
          key={c.id}
          onOpen={onOpenConversation}
        />
      ))}
      {state.cursor && (
        <Button
          className="mx-2 mt-1 text-muted-foreground"
          disabled={loadingMore}
          onClick={loadMore}
          size="sm"
          variant="ghost"
        >
          {loadingMore ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  )
}

function ListSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-0.5 p-2">
      {Array.from({ length: 7 }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows, no identity
        <div className="flex items-center gap-3 px-3 py-2.5" key={i}>
          <div className="size-10 shrink-0 animate-pulse rounded-full bg-muted" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3.5 w-2/5 animate-pulse rounded bg-muted" />
            <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  )
}

function EmptyState({
  icon,
  title,
  children,
}: {
  icon: typeof InboxIcon
  title: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <HugeiconsIcon className="size-8 text-muted-foreground" icon={icon} />
      <p className="max-w-xs text-sm text-muted-foreground">{title}</p>
      {children}
    </div>
  )
}
