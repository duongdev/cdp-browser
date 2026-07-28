// Full-screen global message search (PSN-115 WS-E). Two-pane wide layout:
//   left rail = search input + result list (debounced)
//   middle    = the existing ThreadView showing the selected hit's conversation, scrolled +
//               flashed to the hit message via the thread's `jumpTarget` prop
//
// The AI column + conversation-list column are HIDDEN on the search route (chat-app gates them).
// Esc returns to `/chat/`. Phone shell is deferred to WS-F/G (wide-only here).
//
// Four-state coverage on the result list (loading / empty / error+retry / populated), keyboard
// nav (j/k move selection, Enter opens, Esc returns), and recent searches persisted to
// localStorage. The hydrate-live-flip subscribes to the WS `messages-upsert` delta and flips
// `hydrated:false` rows to `hydrated:true` in place when their message lands.

import {
  Alert02Icon,
  ArrowLeft01Icon,
  InboxIcon,
  ReloadIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { ChatApiError, type SearchHit, type SearchPage, searchMessages } from "../lib/chat-client"
import { useChatWsFrames } from "../lib/chat-ws-context"
import { relativeTime } from "../lib/conversation-view"
import {
  addRecentSearch,
  applyHydrated,
  highlightSegments,
  loadRecentSearchs,
  RECENT_SEARCHES_KEY,
  serializeRecentSearchs,
} from "../lib/search-view"
import type { TeamsConversation } from "../lib/teams-client"
import { type ThreadHandle, ThreadView } from "./thread-view"

const DEBOUNCE_MS = 250

type ListState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string; degraded?: SearchPage["degraded"] }
  | { status: "ready"; page: SearchHit[]; total: number; degraded?: SearchPage["degraded"] }

export interface SearchViewProps {
  /** The conversation map so a hit's `convId` resolves to the real row for ThreadView. Falls back
   *  to a stub when the conversation isn't in the list (a substrate hit may reference one not yet
   *  opened). Mirrors chat-app's `stubConversation` shape. */
  convById: Record<string, TeamsConversation>
  /** Back to the chat list: returns the user to `/chat/`. */
  onBack: () => void
  /** Name-display preference threaded through to ThreadView. */
  namePref?: import("../lib/display-name").NamePref
}

export function SearchView({ convById, onBack, namePref }: SearchViewProps) {
  const [query, setQuery] = useState("")
  const [state, setState] = useState<ListState>({ status: "idle" })
  // The selected hit drives the middle pane: open that conversation scrolled to its message.
  // `selected` carries the convId + msgId + a nonce so re-clicking the same row re-jumps.
  const [selected, setSelected] = useState<{ convId: string; msgId: string; nonce: number } | null>(
    null,
  )
  const [recent, setRecent] = useState<string[]>(() => {
    try {
      return loadRecentSearchs(localStorage.getItem(RECENT_SEARCHES_KEY))
    } catch {
      return []
    }
  })
  const [focusedIndex, setFocusedIndex] = useState(0)

  const activeThreadRef = useRef<ThreadHandle | null>(null)

  // The running query is the debounced `query`. We track the in-flight request via an
  // AbortController so a slower earlier query can't clobber a faster later one (out-of-order
  // landing — the classic debounce hazard).
  const [debounced, setDebounced] = useState("")
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])

  // Track the latest request so a slow earlier response can't land over a newer one.
  const reqSeq = useRef(0)
  useEffect(() => {
    const q = debounced.trim()
    if (!q) {
      setState({ status: "idle" })
      return
    }
    const mySeq = ++reqSeq.current
    const ac = new AbortController()
    setState({ status: "loading" })
    searchMessages(q, { signal: ac.signal })
      .then((page) => {
        if (mySeq !== reqSeq.current) return
        setState({
          status: "ready",
          page: page.rows,
          total: page.total,
          ...(page.degraded ? { degraded: page.degraded } : {}),
        })
        setFocusedIndex(0)
        // Persist the query as a recent search only on a successful page land.
        setRecent((list) => {
          const next = addRecentSearch(list, q)
          try {
            localStorage.setItem(RECENT_SEARCHES_KEY, serializeRecentSearchs(next))
          } catch {
            // storage disabled (private mode / quota) — the in-memory list still works this session
          }
          return next
        })
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted || mySeq !== reqSeq.current) return
        const message =
          e instanceof ChatApiError
            ? e.code === "rate_limited"
              ? "Teams is rate-limiting search. Try again in a moment."
              : e.code === "invalid_auth"
                ? "Teams sign-in expired — it refreshes when the Teams tab reloads."
                : "Search failed."
            : "Search failed."
        setState({ status: "error", message })
      })
    return () => ac.abort()
  }, [debounced])

  // Hydrate-live-flip: subscribe to the WS hub and flip hydrated:false rows when their message
  // arrives in a `messages-upsert` delta (the BFF's existing push, no new transport).
  useChatWsFrames((frame) => {
    if (frame.type !== "messages-upsert") return
    setState((s) =>
      s.status === "ready"
        ? { ...s, page: applyHydrated(s.page, frame.messages, frame.convId) }
        : s,
    )
  })

  const select = useCallback((hit: SearchHit) => {
    setSelected({ convId: hit.convId, msgId: hit.msgId, nonce: Date.now() })
  }, [])

  const moveFocus = useCallback(
    (delta: 1 | -1) => {
      setFocusedIndex((cur) => {
        if (state.status !== "ready" || state.page.length === 0) return 0
        const n = state.page.length
        return (((cur + delta) % n) + n) % n
      })
    },
    [state],
  )

  // Keyboard nav: j/k move, Enter opens, Esc back. Bound on the root div so the input never
  // swallows them when not typing — but the input's own typing (arrows, etc.) is left alone.
  // Only fires when focus is NOT inside a textarea/input (other than the search field itself for
  // j/k — those are letters and we DO want them to work as nav while the input is focused and
  // empty; when the input has a selection or the user is mid-typing we still defer).
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Esc always wins — even from the input.
      if (e.key === "Escape") {
        e.preventDefault()
        onBack()
        return
      }
      // Skip if the user is typing in the search input — j/k/Enter there mean their literal chars
      // (Enter submits the form / picks recent).
      if (
        e.target instanceof HTMLElement &&
        (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")
      ) {
        return
      }
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault()
        moveFocus(1)
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault()
        moveFocus(-1)
      } else if (e.key === "Enter") {
        if (state.status === "ready") {
          const hit = state.page[focusedIndex]
          if (hit) {
            e.preventDefault()
            select(hit)
          }
        }
      }
    },
    [moveFocus, onBack, select, state, focusedIndex],
  )

  const runRecent = useCallback((q: string) => {
    setQuery(q)
    // The debounce effect picks it up.
  }, [])

  const rows = state.status === "ready" ? state.page : []
  // The selected conversation's metadata. A substrate hit may reference a conversation not in the
  // list — fall back to a stub so ThreadView can still fetch history by id.
  const selectedConv = selected ? (convById[selected.convId] ?? stubFor(selected.convId)) : null

  return (
    <div className="flex h-[var(--app-h,100dvh)] w-full bg-background">
      {/* ── left rail ─────────────────────────────────────────────────────────── */}
      <aside className="flex w-[360px] shrink-0 flex-col border-border border-r">
        <header className="titlebar flex h-12 shrink-0 items-center gap-1 border-border border-b px-2">
          <Button
            aria-label="Back to chat"
            className="text-muted-foreground"
            onClick={onBack}
            size="icon-sm"
            variant="ghost"
          >
            <HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
          </Button>
          <span className="px-1 font-heading font-semibold text-foreground text-sm">Search</span>
        </header>
        <div className="shrink-0 p-2">
          <div className="relative">
            <HugeiconsIcon
              aria-hidden
              className="top-1/2 left-2.5 absolute size-4 -translate-y-1/2 text-muted-foreground"
              icon={Search01Icon}
            />
            <Input
              aria-label="Search messages"
              autoFocus
              className="h-9 pl-8"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Enter in the input picks the first result, if any — matches Slack.
                if (e.key === "Enter" && state.status === "ready") {
                  const hit = state.page[focusedIndex]
                  if (hit) {
                    e.preventDefault()
                    select(hit)
                  }
                }
              }}
              placeholder="Search messages…  from:  in:  after:  has:link"
              value={query}
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {state.status === "idle" ? (
            recent.length > 0 ? (
              <RecentList onPick={runRecent} queries={recent} />
            ) : (
              <EmptyState
                hint="Type a word, or use from: / in: / after: / has:link / mentions:me"
                icon={
                  <HugeiconsIcon className="size-8 text-muted-foreground/60" icon={Search01Icon} />
                }
                title="Search all your messages"
              />
            )
          ) : state.status === "loading" ? (
            <ResultSkeleton />
          ) : state.status === "error" ? (
            <CenteredState>
              <HugeiconsIcon className="size-8 text-muted-foreground" icon={Alert02Icon} />
              <p className="max-w-xs text-muted-foreground text-sm">{state.message}</p>
              <Button
                onClick={() => {
                  // Re-trigger the same query.
                  const q = debounced
                  setDebounced("")
                  setTimeout(() => setDebounced(q), 0)
                }}
                size="sm"
                variant="outline"
              >
                <HugeiconsIcon icon={ReloadIcon} />
                Retry
              </Button>
            </CenteredState>
          ) : rows.length === 0 ? (
            <EmptyState
              hint="Try a different word, or remove a filter."
              icon={<HugeiconsIcon className="size-8 text-muted-foreground/60" icon={InboxIcon} />}
              title="No messages"
            />
          ) : (
            <>
              {state.degraded && (
                <div className="mx-2 mb-1 mt-1 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-2.5 py-1.5 text-yellow-700 text-xs dark:text-yellow-300">
                  Showing local results only — live search is temporarily unavailable.
                </div>
              )}
              <div
                aria-label="Search results"
                className="py-1"
                onKeyDown={onKeyDown}
                role="listbox"
                tabIndex={0}
              >
                {rows.map((hit, i) => (
                  <ResultRow
                    focused={i === focusedIndex}
                    hit={hit}
                    key={`${hit.convId}:${hit.msgId}`}
                    onClick={() => select(hit)}
                    onEnter={() => select(hit)}
                    parseText={debounced.trim()}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </aside>

      {/* ── middle pane ───────────────────────────────────────────────────────── */}
      <section className="relative min-w-0 flex-1">
        {selectedConv ? (
          <ThreadView
            conversation={selectedConv}
            jumpTarget={selected ? { id: selected.msgId, nonce: selected.nonce } : undefined}
            key={selectedConv.id}
            namePref={namePref}
            onBack={onBack}
            ref={activeThreadRef}
            visible
          />
        ) : (
          <CenteredState>
            <HugeiconsIcon className="size-10 text-muted-foreground/40" icon={Search01Icon} />
            <p className="text-muted-foreground text-sm">Pick a result to read it in context.</p>
          </CenteredState>
        )}
      </section>
    </div>
  )
}

/** A minimal conversation row for a substrate hit that references a conversation not in the local
 *  list. ThreadView only needs `id` + `kind` to fetch history by id; the rest is filled in as the
 *  server returns messages. */
function stubFor(convId: string): TeamsConversation {
  return {
    id: convId,
    kind: "group",
    topic: null,
    lastMessageId: null,
    lastMessageVersion: 0,
    lastMessageTs: null,
    lastMessagePreview: "",
    readTs: 0,
    lastMessageFromMe: false,
    unreadSticky: false,
    muted: false,
  }
}

function ResultRow({
  hit,
  focused,
  onClick,
  onEnter,
  parseText,
}: {
  hit: SearchHit
  focused: boolean
  onClick: () => void
  onEnter: () => void
  /** The free-text portion of the query (operators stripped) to highlight in the snippet. */
  parseText: string
}) {
  const segs = useMemo(() => highlightSegments(hit.snippet, parseText), [hit.snippet, parseText])
  return (
    <div aria-selected={focused} role="option">
      <button
        className={cn(
          "flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left hover:bg-accent",
          focused && "bg-accent/60",
        )}
        onClick={onClick}
        onDoubleClick={onEnter}
        type="button"
      >
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate font-medium text-sm">
            {hit.sender || "Unknown"}
            <span className="text-muted-foreground"> · {hit.convTitle ?? hit.convId}</span>
          </span>
          <span className="shrink-0 text-muted-foreground text-xs">{relativeTime(hit.ts)}</span>
        </span>
        <span className="line-clamp-2 text-muted-foreground text-sm">
          {segs
            ? segs.map((s, i) =>
                i % 2 === 1 ? (
                  <mark className="rounded-sm bg-yellow-300/40 px-0.5" key={`m-${s}`}>
                    {s}
                  </mark>
                ) : (
                  <span key={`t-${s}`}>{s}</span>
                ),
              )
            : hit.snippet}
        </span>
        {/* Substrate-not-yet-hydrated indicator: a tiny muted pill. Local/hydrated = nothing. */}
        {!hit.hydrated && (
          <span className="mt-0.5 self-start rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            fetching context…
          </span>
        )}
      </button>
    </div>
  )
}

function RecentList({ queries, onPick }: { queries: string[]; onPick: (q: string) => void }) {
  return (
    <div className="px-2 py-1">
      <div className="px-1.5 py-1 font-medium text-muted-foreground text-xs">Recent searches</div>
      <ul>
        {queries.map((q) => (
          <li key={q}>
            <button
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => onPick(q)}
              type="button"
            >
              <HugeiconsIcon
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground"
                icon={Search01Icon}
              />
              <span className="truncate">{q}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function EmptyState({ icon, title, hint }: { icon: React.ReactNode; title: string; hint: string }) {
  return (
    <CenteredState>
      {icon}
      <p className="font-medium text-sm">{title}</p>
      <p className="max-w-xs text-center text-muted-foreground text-xs">{hint}</p>
    </CenteredState>
  )
}

function ResultSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-2 p-2">
      {[0, 1, 2, 3, 4].map((i) => (
        <div className="flex flex-col gap-1 rounded-md px-2.5 py-2" key={i}>
          <div className="flex justify-between">
            <div className="h-3.5 w-1/3 animate-pulse rounded bg-muted" />
            <div className="h-3 w-10 animate-pulse rounded bg-muted" />
          </div>
          <div className="h-3 w-full animate-pulse rounded bg-muted" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  )
}

function CenteredState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      {children}
    </div>
  )
}
