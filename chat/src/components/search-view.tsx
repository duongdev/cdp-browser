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
  BubbleChatIcon,
  Cancel01Icon,
  InboxIcon,
  Loading03Icon,
  ReloadIcon,
  Search01Icon,
  UserCircleIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { parseISO } from "date-fns"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import {
  ChatApiError,
  fetchPeople,
  type ParsedQuery,
  type PersonSuggestion,
  type SearchHit,
  type SearchPage,
  searchMessages,
} from "../lib/chat-client"
import { parseSearchUrlState, pathForSearch } from "../lib/chat-route"
import { chatShell } from "../lib/chat-shell"
import { useChatWsFrames } from "../lib/chat-ws-context"
import { relativeTime } from "../lib/conversation-view"
import { applySuggestion, detectSuggestion, type SuggestionRange } from "../lib/search-suggest"
import {
  addRecentSearch,
  applyHydrated,
  DEFAULT_SCOPE_KIND,
  DEFAULT_SORT,
  filterChips,
  highlightSegments,
  loadRecentSearchs,
  parseSort,
  RECENT_SEARCHES_KEY,
  removeRecentSearch,
  SCOPE_KINDS,
  type ScopeKind,
  SEARCH_SORT_KEY,
  type SearchSort,
  SORTS,
  serializeRecentSearchs,
} from "../lib/search-view"
import type { TeamsConversation } from "../lib/teams-client"
import { type ThreadHandle, ThreadView } from "./thread-view"

/** Best-effort YYYY-MM-DD → Date for the date picker's initial selection. Invalid → null. */
const parseDate = (raw: string): Date | null => {
  const v = raw.trim()
  if (!v) return null
  const d = parseISO(v)
  return Number.isNaN(d.getTime()) ? null : d
}

const DEBOUNCE_MS = 250
/** Idle window before a query is written to search history. Longer than DEBOUNCE_MS so the
 *  intermediate queries of one continuous typing run collapse into a single history entry. */
const RECENT_SETTLE_MS = 1200

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
  /** Exit search and open a conversation in the normal list view (`/chat/c/{convId}`). Surfaced as
   *  an "Open in chat" action once a hit is selected. */
  onOpenInList: (convId: string) => void
  /** Name-display preference threaded through to ThreadView. */
  namePref?: import("../lib/display-name").NamePref
  /** Left-rail width, synced with the conversation list's own drag-resizable width (`settings.
   *  listWidth`) so the two surfaces feel like one app, not two differently-sized panels. */
  listWidth: number
  onResizeDown: (e: React.PointerEvent) => void
  onResetWidth: () => void
}

export function SearchView({
  convById,
  onBack,
  onOpenInList,
  namePref,
  listWidth,
  onResizeDown,
  onResetWidth,
}: SearchViewProps) {
  // Restore query/sort/scope from the URL on mount (refresh / a shared link) — read once, lazy
  // init only. Later changes sync OUT to the URL via `history.replaceState` (never `pushState` —
  // one search shouldn't spam back-button history per keystroke).
  const initialUrlState = useRef(parseSearchUrlState(window.location.search)).current
  const [query, setQuery] = useState(initialUrlState.q ?? "")
  const [state, setState] = useState<ListState>({ status: "idle" })
  // The selected hit drives the middle pane: open that conversation scrolled to its message.
  // `selected` carries the convId + msgId + a nonce (so re-clicking the same row re-jumps) + the
  // hit's own `convKind` — needed so a not-yet-listed conversation's stub reflects its REAL kind
  // instead of a hardcoded guess (bug: every un-listed hit rendered "Group chat" even for a DM).
  const [selected, setSelected] = useState<{
    convId: string
    msgId: string
    nonce: number
    convKind: SearchHit["convKind"]
    convTitle: SearchHit["convTitle"]
  } | null>(null)

  // ---- KQL suggestion dropdown (from:/in:) — mirrors the composer @-mention picker ---------
  const inputRef = useRef<HTMLInputElement>(null)
  const [caret, setCaret] = useState(0)
  const suggestion = useMemo(() => detectSuggestion(query, caret), [query, caret])
  const [people, setPeople] = useState<PersonSuggestion[]>([])
  const [sugIndex, setSugIndex] = useState(0)
  // `in:` suggestions come from the local conv list (no fetch); `from:` from the people endpoint.
  const convSuggestions = useMemo(() => {
    if (!suggestion || suggestion.kind !== "in") return []
    const partial = suggestion.partial.trim().toLowerCase()
    const all = Object.values(convById)
      .map((c) => ({ id: c.id, label: c.title?.trim() || c.topic?.trim() || "" }))
      .filter((c) => c.label.length > 0)
    const ranked = all.sort((a, b) => a.label.localeCompare(b.label))
    if (!partial) return ranked.slice(0, 8)
    return ranked.filter((c) => c.label.toLowerCase().includes(partial)).slice(0, 8)
  }, [suggestion, convById])
  // `has:` offers the parser's known value set (link/file/attachment) — a small fixed list.
  const hasSuggestions = useMemo(() => {
    if (!suggestion || suggestion.kind !== "has") return []
    const partial = suggestion.partial.trim().toLowerCase()
    const all = ["link", "file", "attachment"].map((v) => ({ id: v, label: v }))
    return partial ? all.filter((v) => v.label.includes(partial)) : all
  }, [suggestion])
  const sugItems =
    suggestion?.kind === "in"
      ? convSuggestions
      : suggestion?.kind === "has"
        ? hasSuggestions
        : people.map((p) => ({ id: p.id, label: p.displayName }))
  // `after:`/`before:` show a calendar instead of a list — flagged so the popover + keyboard nav
  // switch modes (the calendar owns its own arrow/enter handling).
  const dateMode = suggestion?.kind === "after" || suggestion?.kind === "before"
  // Fetch people only when a `from:` token is open.
  useEffect(() => {
    if (suggestion?.kind !== "from") {
      setPeople([])
      return
    }
    const ac = new AbortController()
    const t = setTimeout(() => {
      fetchPeople(suggestion.partial, ac.signal)
        .then((rows) => {
          setPeople(rows)
          setSugIndex(0)
        })
        .catch(() => {})
    }, 150) // debounce — don't hammer the endpoint per keystroke
    return () => {
      clearTimeout(t)
      ac.abort()
    }
  }, [suggestion])
  // Reset the selection when the item set changes.
  useEffect(() => setSugIndex(0), [sugItems.length])
  const applyPick = useCallback(
    (label: string) => {
      if (!suggestion) return
      const { value: next, caret } = applySuggestion(query, suggestion, label)
      setQuery(next)
      setCaret(caret)
      requestAnimationFrame(() => {
        const el = inputRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(caret, caret)
      })
    },
    [query, suggestion],
  )
  // `after:`/`before:` — a date pick formats as YYYY-MM-DD (the parser's accepted form) and is
  // applied the same way a list pick is.
  const applyDate = useCallback(
    (date: Date) => {
      if (!suggestion) return
      const yyyy = date.getFullYear()
      const mm = String(date.getMonth() + 1).padStart(2, "0")
      const dd = String(date.getDate()).padStart(2, "0")
      applyPick(`${yyyy}-${mm}-${dd}`)
    },
    [applyPick, suggestion],
  )
  const [recent, setRecent] = useState<string[]>(() => {
    try {
      return loadRecentSearchs(localStorage.getItem(RECENT_SEARCHES_KEY))
    } catch {
      return []
    }
  })
  const persistRecent = useCallback((next: string[]) => {
    try {
      localStorage.setItem(RECENT_SEARCHES_KEY, serializeRecentSearchs(next))
    } catch {
      // storage disabled (private mode / quota) — the in-memory list still works this session
    }
  }, [])
  const removeRecent = useCallback(
    (q: string) => {
      setRecent((list) => {
        const next = removeRecentSearch(list, q)
        persistRecent(next)
        return next
      })
    },
    [persistRecent],
  )
  // The last query that produced results and is therefore eligible for history. Written by the
  // fetch, consumed by the settle effect (or Enter) — a ref so it never re-renders.
  const saveableRef = useRef<string | null>(null)
  const commitRecent = useCallback(
    (q?: string) => {
      const value = (q ?? saveableRef.current ?? "").trim()
      if (!value) return
      saveableRef.current = null
      setRecent((list) => {
        const next = addRecentSearch(list, value)
        persistRecent(next)
        return next
      })
    },
    [persistRecent],
  )
  const clearAllRecent = useCallback(() => {
    setRecent([])
    persistRecent([])
  }, [persistRecent])
  const [focusedIndex, setFocusedIndex] = useState(0)

  // Sort + scope (WS-F). Sort persists across sessions (chat-scoped localStorage, like recent
  // searches). Scope is session-only for v1 — a persistent default would mask new DMs silently.
  const [sort, setSort] = useState<SearchSort>(() => {
    if (initialUrlState.sort) return initialUrlState.sort
    try {
      return parseSort(localStorage.getItem(SEARCH_SORT_KEY))
    } catch {
      return DEFAULT_SORT
    }
  })
  const [scopeKind, setScopeKind] = useState<ScopeKind>(initialUrlState.scope ?? DEFAULT_SCOPE_KIND)

  // The last successfully-landed parsed query — keeps chips visible while the next query is in
  // flight (so toggling sort/scope or removing a chip doesn't blank the bar mid-request).
  const [parsed, setParsed] = useState<ParsedQuery | null>(null)

  const activeThreadRef = useRef<ThreadHandle | null>(null)

  // The running query is the debounced `query`. We track the in-flight request via an
  // AbortController so a slower earlier query can't clobber a faster later one (out-of-order
  // landing — the classic debounce hazard).
  // A URL-restored query runs immediately (no artificial wait on page load); a typed query still
  // debounces.
  const [debounced, setDebounced] = useState(initialUrlState.q ?? "")
  const skipNextDebounce = useRef(Boolean(initialUrlState.q))
  useEffect(() => {
    if (skipNextDebounce.current) {
      skipNextDebounce.current = false
      return
    }
    const t = setTimeout(() => setDebounced(query), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])

  // Sync query/sort/scope OUT to the URL (PSN-115 follow-up: a refresh used to drop the user back
  // to an empty search — the whole surface was unrecoverable across a reload). `replaceState`, not
  // `pushState` — a plain search shouldn't grow the back-button stack per query/toggle change.
  useEffect(() => {
    const path = pathForSearch({ q: debounced || undefined, sort, scope: scopeKind })
    if (window.location.pathname + window.location.search !== path) {
      window.history.replaceState(window.history.state, "", path)
    }
  }, [debounced, sort, scopeKind])

  // Track the latest request so a slow earlier response can't land over a newer one.
  const reqSeq = useRef(0)
  useEffect(() => {
    const q = debounced.trim()
    if (!q) {
      setState({ status: "idle" })
      setParsed(null)
      return
    }
    const mySeq = ++reqSeq.current
    const ac = new AbortController()
    setState({ status: "loading" })
    searchMessages(q, {
      sort,
      scope: { kind: scopeKind },
      signal: ac.signal,
    })
      .then((page) => {
        if (mySeq !== reqSeq.current) return
        setState({
          status: "ready",
          page: page.rows,
          total: page.total,
          ...(page.degraded ? { degraded: page.degraded } : {}),
        })
        setParsed(page.parsed ?? { text: q, filters: {} })
        setFocusedIndex(0)
        // A landed page only marks the query as SAVEABLE — the settle effect below decides when to
        // actually write it to history, so typing "hel" → pause → "lo" leaves one "hello" entry
        // rather than one per intermediate query that happened to land.
        saveableRef.current = q
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
  }, [debounced, sort, scopeKind])

  // History settle: only write a recent search once the user STOPS typing for a beat. Typing
  // "hel" → pause → "lo" fires two searches (both land) but must leave ONE "hello" entry, not
  // "hel" + "hello". The timer restarts on every keystroke, so only the final query survives.
  // Enter commits immediately (see the input's onKeyDown) for the impatient path.
  useEffect(() => {
    if (!query.trim()) return
    const t = setTimeout(() => commitRecent(), RECENT_SETTLE_MS)
    return () => clearTimeout(t)
  }, [query, commitRecent])

  const onSortChange = useCallback((next: SearchSort) => {
    setSort(next)
    try {
      localStorage.setItem(SEARCH_SORT_KEY, next)
    } catch {
      // storage disabled — in-memory sort still works this session
    }
  }, [])

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
    setSelected({
      convId: hit.convId,
      msgId: hit.msgId,
      nonce: Date.now(),
      convKind: hit.convKind,
      convTitle: hit.convTitle,
    })
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
  const selectedConv = selected
    ? (convById[selected.convId] ?? stubFor(selected.convId, selected.convKind, selected.convTitle))
    : null

  return (
    <div className="flex h-[var(--app-h,100dvh)] w-full bg-background">
      {/* ── left rail ─────────────────────────────────────────────────────────── */}
      <aside className="flex shrink-0 flex-col border-border border-r" style={{ width: listWidth }}>
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
          {/* Hidden on the Electron shell: the frameless titlebar puts the macOS traffic lights
              top-left, which clip a title here (mirrors chat-app's Electron-title handling). Web/PWA
              has no traffic lights, so the label stays. */}
          {!chatShell() && (
            <span className="px-1 font-heading font-semibold text-foreground text-sm">Search</span>
          )}
        </header>
        <div className="shrink-0 px-3 pt-3 pb-2">
          <div className="relative">
            <HugeiconsIcon
              aria-hidden
              className="top-1/2 left-3 absolute size-4 -translate-y-1/2 text-muted-foreground"
              icon={Search01Icon}
            />
            <Input
              aria-autocomplete="list"
              aria-controls={suggestion && sugItems.length > 0 ? "search-suggest-list" : undefined}
              aria-expanded={suggestion != null && sugItems.length > 0}
              aria-label="Search messages"
              autoFocus
              className="h-10 pl-9 pr-3"
              onChange={(e) => {
                setQuery(e.target.value)
                setCaret(e.target.selectionStart ?? e.target.value.length)
              }}
              onKeyDown={(e) => {
                // The suggestion dropdown owns navigation while open — mirrors the composer
                // @-mention picker: Arrow/Enter/Tab pick, Esc closes, else falls through. Date
                // mode (after:/before:) is skipped here — the calendar owns its own arrow/enter
                // handling and these keys must reach it.
                if (suggestion && sugItems.length > 0 && !dateMode) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault()
                    setSugIndex((i) => (i + 1) % sugItems.length)
                    return
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault()
                    setSugIndex((i) => (i - 1 + sugItems.length) % sugItems.length)
                    return
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    const pick = sugItems[sugIndex]
                    if (pick) {
                      e.preventDefault()
                      applyPick(pick.label)
                      return
                    }
                  }
                  if (e.key === "Escape") {
                    // Collapse the suggestion by nudging the caret out of the token (a trailing
                    // space) so the user keeps typing free text.
                    e.preventDefault()
                    const el = e.currentTarget
                    const pos = el.selectionStart ?? query.length
                    const next = `${query.slice(0, pos)} `
                    setQuery(next)
                    requestAnimationFrame(() => el.setSelectionRange(next.length, next.length))
                    return
                  }
                }
                // Enter with no suggestion open commits the query to history immediately (the
                // impatient path — no need to wait out RECENT_SETTLE_MS) and picks the focused
                // search result (Slack-like).
                if (e.key === "Enter") {
                  commitRecent(query)
                  if (state.status === "ready") {
                    const hit = state.page[focusedIndex]
                    if (hit) {
                      e.preventDefault()
                      select(hit)
                    }
                  }
                }
              }}
              onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? query.length)}
              onSelect={(e) =>
                setCaret((e.currentTarget as HTMLInputElement).selectionStart ?? query.length)
              }
              placeholder="Search messages…  from:  in:  after:  has:link"
              ref={inputRef}
              value={query}
            />
            {suggestion && !dateMode && sugItems.length > 0 && (
              <SuggestionPopover
                id="search-suggest-list"
                index={sugIndex}
                items={sugItems}
                kind={suggestion.kind}
                onPick={applyPick}
              />
            )}
            {suggestion && dateMode && (
              <DateSuggestionPopover
                kind={suggestion.kind === "after" ? "after" : "before"}
                onPick={applyDate}
                partial={suggestion.partial}
              />
            )}
          </div>
        </div>
        <FilterBar
          onRemoveChip={(remove) => setQuery(remove(query))}
          onScopeChange={setScopeKind}
          onSortChange={onSortChange}
          parsed={parsed}
          scopeKind={scopeKind}
          sort={sort}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {state.status === "idle" ? (
            recent.length > 0 ? (
              <RecentList
                onClearAll={clearAllRecent}
                onPick={runRecent}
                onRemove={removeRecent}
                queries={recent}
              />
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
                <div className="mx-3 mb-1 mt-1 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-2.5 py-1.5 text-yellow-700 text-xs dark:text-yellow-300">
                  Showing local results only — live search is temporarily unavailable.
                </div>
              )}
              <div
                aria-label="Search results"
                className="focus-visible:outline-none focus-visible:ring-inset focus-visible:ring-2 focus-visible:ring-ring/30"
                onKeyDown={onKeyDown}
                role="listbox"
                tabIndex={0}
              >
                {rows.map((hit, i) => (
                  <ResultRow
                    active={selected?.convId === hit.convId && selected?.msgId === hit.msgId}
                    focused={i === focusedIndex}
                    hit={hit}
                    key={`${hit.convId}:${hit.msgId}`}
                    onClick={() => select(hit)}
                    onEnter={() => select(hit)}
                    parseText={parsed?.text ?? debounced.trim()}
                    resolvedTitle={
                      // A substrate-only hit may carry a null convTitle even when the conversation
                      // IS listed locally — fall back to the listed row's resolved title so the
                      // result reads a real name, not the raw id / "Group chat".
                      hit.convTitle ?? convById[hit.convId]?.title ?? null
                    }
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </aside>

      {/* ── middle pane ───────────────────────────────────────────────────────── */}
      <section className="relative min-w-0 flex-1">
        {/* Same drag-resize seam as the conversation list (chat-app.tsx) — shares `listWidth` so
            the column feels like one app's rail, not a second differently-sized panel. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-drag resize handle */}
        <div
          className="-translate-x-1/2 absolute inset-y-0 left-0 z-20 w-1 cursor-col-resize hover:bg-accent"
          onDoubleClick={onResetWidth}
          onPointerDown={onResizeDown}
          title="Drag to resize · double-click to reset"
        />
        {selectedConv ? (
          <>
            {/* Exit search → open the conversation in the normal list view (`/chat/c/{id}`). A
                search hit reads in context here, but the user often wants the full chat: this
                escapes the search surface entirely. Floating top-right so it never covers the
                thread header's title. */}
            <Button
              className="absolute top-2 right-3 z-20 gap-1.5 shadow-sm"
              onClick={() => onOpenInList(selectedConv.id)}
              size="sm"
              variant="secondary"
            >
              <HugeiconsIcon className="size-4" icon={BubbleChatIcon} />
              Open in chat
            </Button>
            <ThreadView
              conversation={selectedConv}
              jumpTarget={selected ? { id: selected.msgId, nonce: selected.nonce } : undefined}
              key={selectedConv.id}
              namePref={namePref}
              onBack={onBack}
              ref={activeThreadRef}
              visible
            />
          </>
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
// `kind` comes from the hit itself when known (server has this conv locally); a substrate-only
// reference the server never ingested has no kind — "group" is the least-wrong guess there (a
// bare DM ThreadView header degrades to "Direct message" either way once real data lands).
function stubFor(
  convId: string,
  kind: TeamsConversation["kind"] | null,
  title: string | null,
): TeamsConversation {
  return {
    id: convId,
    kind: kind ?? "group",
    // The substrate hit already carries the server-resolved conversation title (member names for a
    // topic-less DM/group), so surface it here — without it ThreadView's header reads "Group chat"
    // until real data lands. Absent = truly unresolved.
    ...(title ? { title } : {}),
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

// ---- WS-F: filter bar (chips + sort + scope) -------------------------------

function FilterBar({
  parsed,
  sort,
  scopeKind,
  onRemoveChip,
  onSortChange,
  onScopeChange,
}: {
  parsed: ParsedQuery | null
  sort: SearchSort
  scopeKind: ScopeKind
  onRemoveChip: (remove: (currentQuery: string) => string) => void
  onSortChange: (next: SearchSort) => void
  onScopeChange: (next: ScopeKind) => void
}) {
  // ponytail: chips render from the LAST landed parsed query so they stay visible while the next
  // query is in flight. The bar itself (sort + scope) must stay visible for ANY landed query — a
  // plain string search with no KQL operators has zero chips but sort/scope still apply to it.
  // (Bug: this used to hide the whole bar, including sort/scope, whenever there were no chips.)
  const chips = parsed ? filterChips(parsed) : []
  if (!parsed) return null
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-border border-b px-3 py-2">
      {chips.length > 0 && (
        <ul aria-label="Active filters" className="flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <li key={chip.key}>
              <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/60 px-2 py-0.5 text-foreground text-xs">
                <span className="truncate">{chip.label}</span>
                <button
                  aria-label={`Remove filter ${chip.label}`}
                  className="-mr-1 flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  onClick={() => onRemoveChip(chip.removeQuery)}
                  type="button"
                >
                  <HugeiconsIcon className="size-3" icon={Cancel01Icon} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1">
        <ToggleGroup
          aria-label="Sort results"
          className="gap-0.5"
          onValueChange={(v) => {
            if (v === "relevance" || v === "recent") onSortChange(v)
          }}
          size="sm"
          type="single"
          value={sort}
        >
          {SORTS.map((s) => (
            <ToggleGroupItem
              aria-label={s === "relevance" ? "Sort by relevance" : "Sort by recent"}
              className="text-muted-foreground text-xs data-[state=on]:bg-muted data-[state=on]:text-foreground"
              key={s}
              value={s}
            >
              {s === "relevance" ? "Relevance" : "Recent"}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div aria-hidden className="h-4 w-px bg-border" />
        <ToggleGroup
          aria-label="Scope"
          className="gap-0.5"
          onValueChange={(v) => {
            if (v === "all" || v === "dm" || v === "group") onScopeChange(v)
          }}
          size="sm"
          type="single"
          value={scopeKind}
        >
          {SCOPE_KINDS.map((k) => (
            <ToggleGroupItem
              aria-label={`Scope: ${k}`}
              className="text-muted-foreground text-xs capitalize data-[state=on]:bg-muted data-[state=on]:text-foreground"
              // ponytail: folder/label scope needs a picker over conversation_prefs and is a
              // declared WS-F follow-up — only the 3 structural kinds are surfaced here.
              key={k}
              value={k}
            >
              {k === "dm" ? "DMs" : k === "group" ? "Groups" : "All"}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
    </div>
  )
}

function ResultRow({
  hit,
  focused,
  active,
  onClick,
  onEnter,
  parseText,
  resolvedTitle,
}: {
  hit: SearchHit
  focused: boolean
  /** Persistently highlighted when this row's message is the one open in the middle pane. */
  active: boolean
  onClick: () => void
  onEnter: () => void
  /** The free-text portion of the query (operators stripped) to highlight in the snippet. */
  parseText: string
  /** Conversation title resolved by the parent (hit.convTitle, else the listed row's title). */
  resolvedTitle: string | null
}) {
  const segs = useMemo(() => highlightSegments(hit.snippet, parseText), [hit.snippet, parseText])
  return (
    <div aria-selected={focused} role="option" tabIndex={-1}>
      <button
        className={cn(
          // mx-3 + w-[calc(100%-1.5rem)] aligns the row's box to the search input's px-3 edges so
          // the result list and the input read as one column (pixel-perfect, not wider/narrower).
          "mx-3 my-0.5 flex w-[calc(100%-1.5rem)] flex-col gap-1 rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors",
          "hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          active && "border-ring/40 bg-accent",
          !active && focused && "bg-muted",
        )}
        onClick={onClick}
        onDoubleClick={onEnter}
        type="button"
      >
        <span className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 truncate text-foreground text-sm">
            <span className="font-semibold">{hit.sender || "Unknown"}</span>
            <span className="text-muted-foreground"> · </span>
            <span className="text-muted-foreground">{resolvedTitle ?? hit.convId}</span>
          </span>
          <span className="shrink-0 font-mono text-muted-foreground text-xs">
            {relativeTime(hit.ts)}
          </span>
        </span>
        <span className="line-clamp-2 text-foreground/80 text-sm leading-snug">
          {segs
            ? segs.map((s, i) =>
                i % 2 === 1 ? (
                  <mark
                    className="rounded-sm bg-yellow-300/40 px-0.5 text-foreground dark:bg-yellow-300/25 dark:text-foreground"
                    key={`m-${s}`}
                  >
                    {s}
                  </mark>
                ) : (
                  <span key={`t-${s}`}>{s}</span>
                ),
              )
            : hit.snippet}
        </span>
        {/* Substrate-not-yet-hydrated indicator: a tiny muted pill with a spinning glyph. Local/
            hydrated = nothing. Flips away the moment the WS messages-upsert delta lands the row. */}
        {!hit.hydrated && (
          <span
            aria-label="Fetching message context"
            className="mt-0.5 inline-flex items-center gap-1 self-start rounded-full bg-muted/80 px-2 py-0.5 text-muted-foreground text-[10px] capitalize"
            role="status"
          >
            <HugeiconsIcon aria-hidden className="size-3 animate-spin" icon={Loading03Icon} />
            fetching context
          </span>
        )}
      </button>
    </div>
  )
}

function RecentList({
  queries,
  onPick,
  onRemove,
  onClearAll,
}: {
  queries: string[]
  onPick: (q: string) => void
  onRemove: (q: string) => void
  onClearAll: () => void
}) {
  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="font-medium text-muted-foreground text-[11px] uppercase tracking-wide">
          Recent searches
        </span>
        <button
          className="rounded px-1 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          onClick={onClearAll}
          type="button"
        >
          Clear all
        </button>
      </div>
      <ul className="flex flex-col gap-0.5">
        {queries.map((q) => (
          <li className="group flex items-center" key={q}>
            <button
              className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
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
            <button
              aria-label={`Remove "${q}" from recent searches`}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 group-hover:opacity-100"
              onClick={() => onRemove(q)}
              type="button"
            >
              <HugeiconsIcon className="size-3" icon={Cancel01Icon} />
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
      <p className="font-medium text-foreground text-sm">{title}</p>
      <p className="max-w-xs text-center text-muted-foreground text-xs leading-relaxed">{hint}</p>
    </CenteredState>
  )
}

// The KQL suggestion dropdown (PSN-115 follow-up): people for `from:`, conversations for `in:`,
// fixed values for `has:`. Anchored under the search input; keyboard nav is driven by the input's
// onKeyDown (this just renders + reports a click). Mirrors the composer @-mention picker's look.
function SuggestionPopover({
  id,
  kind,
  items,
  index,
  onPick,
}: {
  id: string
  kind: SuggestionRange["kind"]
  items: { id: string; label: string }[]
  index: number
  onPick: (label: string) => void
}) {
  const heading = kind === "from" ? "People" : kind === "in" ? "Conversations" : "Has"
  return (
    <div
      className="absolute top-full left-0 z-30 mt-1 w-full overflow-hidden rounded-lg border border-border bg-popover shadow-md"
      id={id}
      role="listbox"
    >
      <div className="border-border border-b px-2.5 py-1 text-[10px] tracking-wide text-muted-foreground uppercase">
        {heading}
      </div>
      <ul className="max-h-60 overflow-y-auto py-1">
        {items.map((item, i) => (
          <li key={item.id}>
            <button
              aria-selected={i === index}
              className={cn(
                "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm",
                i === index ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
              )}
              onClick={() => onPick(item.label)}
              onMouseDown={(e) => e.preventDefault()} // keep the input's focus/selection
              role="option"
              type="button"
            >
              <HugeiconsIcon
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground"
                icon={kind === "from" ? UserCircleIcon : BubbleChatIcon}
              />
              <span className="truncate">{item.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ResultSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-0.5 p-2">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div className="flex flex-col gap-1.5 rounded-lg px-3 py-2.5" key={i}>
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
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      {children}
    </div>
  )
}

// The `after:`/`before:` date picker (PSN-115 follow-up). A shadcn Calendar in a popover anchored
// under the search input; selecting a day formats it as YYYY-MM-DD and applies it like any list
// pick. `before:` caps the selectable range at today (no future dates); `after:` is unrestricted.
function DateSuggestionPopover({
  kind,
  partial,
  onPick,
}: {
  kind: "after" | "before"
  partial: string
  onPick: (date: Date) => void
}) {
  const initial = parseDate(partial)
  const today = new Date()
  return (
    <div className="absolute top-full left-0 z-30 mt-1 w-auto overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-md">
      <Calendar
        disabled={kind === "before" ? { after: today } : undefined}
        mode="single"
        numberOfMonths={1}
        onSelect={(day) => {
          if (day) onPick(day)
        }}
        selected={initial ?? undefined}
        today={today}
      />
    </div>
  )
}
