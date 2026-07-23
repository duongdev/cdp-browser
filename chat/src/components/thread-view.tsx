import {
  Alert02Icon,
  ArrowLeft01Icon,
  Attachment01Icon,
  Cancel01Icon,
  File01Icon,
  InboxIcon,
  ReloadIcon,
  SentIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { conversationLabel } from "../lib/conversation-view"
import { pickFile } from "../lib/image-attach"
import { applyPendingReactions, applyReaction, mergeMessages } from "../lib/message-merge"
import {
  deleteMessage,
  editMessage,
  fetchHistory,
  markRead,
  react,
  sendReply,
  TeamsApiError,
  type TeamsConversation,
  type TeamsMessage,
  uploadFile,
  uploadImage,
} from "../lib/teams-client"
import { reduceSend, type SendState, selectReplyTarget } from "../lib/teams-reply"
import { MessageRow, type RowCommand } from "./message-row"

// Live sync (t135, poll-first): cadence for re-fetching the newest history page while this pane is
// the visible one and the tab is foregrounded.
const THREAD_POLL_MS = 4000
// Stick-to-bottom slack: within this many px of the bottom, a merge that lands newer content
// re-pins to the bottom; farther up we leave scroll alone so we don't yank someone reading history.
const THREAD_BOTTOM_SLACK = 64
// A pending optimistic reaction is overlaid on every merge until the server confirms it, or until it
// ages past this window — a lost write shouldn't pin a phantom reaction forever (t143).
const PENDING_REACTION_TTL_MS = 20000

/** One in-flight optimistic reaction the viewer made: the target `mine` state, the emoji to draw,
 *  and when it was fired (for the failed-write timeout). Keyed msgId → key. */
type PendingReactions = Map<
  string,
  Map<string, { emoji: string; desiredMine: boolean; ts: number }>
>

/** Drop pending entries the server has caught up on, or that have aged out (t143). Mutates in place.
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

// Lowercased extension for the optimistic file chip's icon (mirrors core/teams-files.js:fileExt;
// the CJS core isn't importable into the typechecked chat bundle). The next poll's server-rendered
// chip carries the authoritative type. No dot / leading-dot / trailing-dot → "file".
const pendingExt = (name: string): string => {
  const dot = name.lastIndexOf(".")
  return dot <= 0 || dot === name.length - 1 ? "file" : name.slice(dot + 1).toLowerCase()
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

/** The focused message the thread reports up (t152) — id + own-ness, for the palette/keys context. */
export interface ThreadFocus {
  id: string
  isOwn: boolean
}

/** Imperative keyboard API the active pane exposes to chat-app (t152). Only the active+visible pane's
 *  handle is driven; message focus lives here (per pane) so each thread keeps its own cursor. */
export interface ThreadHandle {
  focusNext: () => void
  focusPrev: () => void
  getFocused: () => ThreadFocus | null
  /** Dispatch a keyboard command (edit/delete/react) at the focused message's row. */
  command: (type: RowCommand["type"]) => void
  /** True while the composer or inline editor holds focus — chat-app suppresses bare-key shortcuts. */
  isComposerFocused: () => boolean
}

interface ThreadViewProps {
  conversation: TeamsConversation
  /** Back to the list — shown on the phone (stacked), hidden in the wide two-pane. */
  onBack?: () => void
  /** Whether this pane is the on-screen one (t132). Inactive panes stay mounted (fetch + scroll
   *  preserved) but hidden via display:none, so switching conversations is instant. Defaults true. */
  visible?: boolean
  /** Reports the keyboard-focused message up so chat-app's palette/keys context stays in sync (t152).
   *  Only the visible pane should be wired. */
  onFocusChange?: (focus: ThreadFocus | null) => void
}

/** The thread pane (t129, ADR-0019): one conversation's real messages, rendered oldest-first from
 *  server-sanitized ReaderMessages. Four states; scroll-to-top lazily loads an older page. Kept
 *  mounted across conversation switches (t132) — hidden when inactive, never refetched. */
export const ThreadView = forwardRef<ThreadHandle, ThreadViewProps>(function ThreadView(
  { conversation, onBack, visible = true, onFocusChange },
  ref,
) {
  const [state, setState] = useState<State>({ status: "loading" })
  // Older-page paging (t134): the server returns an opaque `backwardLink` cursor with each page;
  // null means there is no older page. `hasMore` mirrors "cursor is non-null" for the affordance.
  const [hasMore, setHasMore] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const olderCursor = useRef<string | null>(null)
  const loadingOlderRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Latest scroll offset, tracked live while visible — display:none drops the container's scrollTop,
  // so this ref (not a read at hide-time, which would already be 0) is what we restore on re-show.
  const savedScrollTop = useRef(0)
  // In-flight optimistic reactions, overlaid on every merge until the server confirms (t143). A ref
  // (not state) — mutating it never needs a re-render; the overlay it drives is applied inside the
  // merge setState. Cleared per conversation switch below.
  const pendingReactions = useRef<PendingReactions>(new Map())
  const convId = conversation.id

  // Keyboard message focus (t152): the id of the focused message row + the command dispatched to it.
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [rowCommand, setRowCommand] = useState<RowCommand | null>(null)
  // Composer/editor focus flag, so chat-app can suppress bare-key shortcuts while typing.
  const composerFocusedRef = useRef(false)

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

  // Trigger load-older from a sentinel at the visual top (mirrors the list's t136 infinite scroll)
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

  // Restore scroll when this pane becomes visible again (t132). display:none resets the container's
  // scrollTop, so re-showing a kept-alive thread must re-seat it. Keyed on `visible` only: on a fresh
  // mount this restores 0 while still loading, then the status→ready scroll-to-bottom lands at bottom
  // and this won't refire (visible unchanged), so first-load bottom still wins.
  useLayoutEffect(() => {
    if (!visible) return
    const el = scrollRef.current
    if (el) el.scrollTop = savedScrollTop.current
  }, [visible])

  // Poll the newest history page and merge it in (t135). Only touches a "ready" state — a loading/
  // error pane is left to the initial load. Errors are swallowed: a failed poll keeps the last-good
  // thread rather than flipping to error. Sticks to the bottom only if the user was already there.
  const poll = useCallback(() => {
    fetchHistory(convId)
      .then((page) => {
        const el = scrollRef.current
        // flex-col-reverse: the bottom (newest) is scrollTop ≈ 0. Only re-pin if already there.
        const nearBottom = el ? Math.abs(el.scrollTop) < THREAD_BOTTOM_SLACK : false
        // Retire optimistic reactions the server now reflects (or that timed out) BEFORE overlaying,
        // so a confirmed reaction stops being pinned and a later real change isn't masked (t143).
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
        // Poll errors are silent (t135) — the last-good thread stays put.
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

  // Reactions (t142): the thread owns message state, so it applies the optimistic toggle here
  // (add/remove self + adjust count via the pure applyReaction) and fires the best-effort server
  // call. The optimistic change is also recorded as a pending overlay (t143) so the 4s poll's
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

  // Edit own message (t144): optimistically swap the body to the plain text + set edited, then PUT
  // it. Returns the client promise so the inline editor can keep itself open + show an error on a
  // rejected write; on success the 4s poll's server-wins merge replaces the plain optimistic body
  // with Teams' rendered edited HTML. No pending overlay — an edit makes the body DIFFER, so the
  // merge reconciles cleanly (unlike a reaction, which the server can lag behind).
  const onEdit = useCallback(
    (msgId: string, text: string): Promise<void> => {
      setState((s) => {
        if (s.status !== "ready") return s
        return {
          status: "ready",
          messages: s.messages.map((m) =>
            m.id === msgId ? { ...m, body: text, edited: true } : m,
          ),
        }
      })
      return editMessage(convId, msgId, text)
    },
    [convId],
  )

  // Delete own message (t144): optimistically tombstone it (matching the read-path tombstone), then
  // DELETE. Fire-and-forget — a failed delete is restored by the next poll's server-wins merge, so
  // the error is swallowed (the message reappears rather than a stuck phantom tombstone).
  const onDelete = useCallback(
    (msgId: string) => {
      setState((s) => {
        if (s.status !== "ready") return s
        return {
          status: "ready",
          messages: s.messages.map((m) =>
            m.id === msgId ? { ...m, body: "message deleted", deleted: true } : m,
          ),
        }
      })
      deleteMessage(convId, msgId).catch(() => {
        // best-effort: the next poll restores the message if the delete didn't land
      })
    },
    [convId],
  )

  // Composer (t130, Q9 hybrid): text-only, synchronous + honest — no outbox. A successful send
  // optimistically appends the message and write-through marks the conversation read on Teams.
  // The reply target is chosen by the single policy owner (selectReplyTarget) — flat for Teams.
  const replyTarget = selectReplyTarget(conversation)
  const [send, setSend] = useState<SendState>({ phase: "idle", draft: "" })
  // A pasted/picked attachment staged for send (t145 image, t146 any file): held until Send uploads
  // it (or the ✕ clears it). An image routes to uploadImage; any other file routes to uploadFile.
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [pendingUrl, setPendingUrl] = useState<string | null>(null)
  const pendingIsImage = pendingFile?.type.startsWith("image/") ?? false
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // Reset the composer when the conversation changes (a half-typed draft / staged file doesn't leak).
  // biome-ignore lint/correctness/useExhaustiveDependencies: convId is the deliberate reset trigger
  useEffect(() => {
    setSend({ phase: "idle", draft: "" })
    setPendingFile(null)
  }, [convId])
  // Object-URL thumbnail preview — images only; a non-image file shows a chip, not a thumbnail.
  useEffect(() => {
    if (!pendingFile?.type.startsWith("image/")) {
      setPendingUrl(null)
      return
    }
    const url = URL.createObjectURL(pendingFile)
    setPendingUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [pendingFile])
  // Auto-grow the textarea up to a cap; height resets to measure the real scrollHeight each edit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: send.draft is the deliberate re-measure trigger
  useLayoutEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`
  }, [send.draft])

  // Append a just-sent optimistic message + pin to the bottom (flex-col-reverse: 0 is the newest).
  const appendSent = useCallback((sent: TeamsMessage) => {
    setState((s) =>
      s.status === "ready" ? { status: "ready", messages: [...s.messages, sent] } : s,
    )
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = 0
    })
  }, [])

  const doSend = useCallback(() => {
    if (!replyTarget || send.phase === "sending") return
    const text = send.draft.trim()

    // Attachment send (t145 image, t146 file): an upload can carry an optional caption, so its draft
    // can be empty — it bypasses reduceSend's non-empty guard. On success the poll reconciles the
    // optimistic bubble to the server-rendered message; on failure the file + caption stay for retry.
    if (pendingFile) {
      const file = pendingFile
      const isImage = file.type.startsWith("image/")
      setSend({ phase: "sending", draft: send.draft })
      const upload = isImage
        ? uploadImage(replyTarget.convId, file, text)
        : uploadFile(replyTarget.convId, file, text)
      upload
        .then((out) => {
          setPendingFile(null)
          setSend({ phase: "idle", draft: "" })
          appendSent({
            id: out.msgId,
            ts: Number(out.msgId) || Date.now(),
            senderId: "",
            senderName: "You",
            body: text,
            self: true,
            edited: false,
            deleted: false,
            // Image → own object URL for the optimistic bubble (revoked with the pending preview);
            // file → a chip descriptor. Either is replaced by the server's rendered message on the
            // next poll (the chip gains its clickable SharePoint url then).
            ...(isImage
              ? { localImageUrl: URL.createObjectURL(file) }
              : {
                  attachments: [
                    { kind: "file", name: file.name || "file", type: pendingExt(file.name) },
                  ],
                }),
          })
          markRead(replyTarget.convId, out.msgId, out.msgId)
        })
        .catch((e) => {
          const code = e instanceof TeamsApiError ? e.code : "network_error"
          setSend((s) => reduceSend(s, { type: "fail", code }))
        })
      return
    }

    const next = reduceSend(send, { type: "send" })
    setSend(next)
    if (next.phase !== "sending") return
    sendReply(replyTarget.convId, text)
      .then((out) => {
        setSend((s) => reduceSend(s, { type: "ok" }))
        appendSent({
          id: out.ts,
          ts: Number(out.ts) || Date.now(),
          senderId: "",
          senderName: "You",
          body: text,
          self: true,
          edited: false,
          deleted: false,
        })
        // Write-through mark-read (best-effort). For Teams, the message id IS its arrival ts.
        markRead(replyTarget.convId, out.ts, out.ts)
      })
      .catch((e) => {
        const code = e instanceof TeamsApiError ? e.code : "network_error"
        setSend((s) => reduceSend(s, { type: "fail", code }))
      })
  }, [send, replyTarget, pendingFile, appendSent])

  // Focusable (non-system) messages in visual order (oldest→newest). System lines aren't focusable.
  const messages = state.status === "ready" ? state.messages : null
  const focusable = useMemo(() => (messages ?? []).filter((m) => m.kind !== "system"), [messages])

  // Reset the keyboard cursor when the conversation changes (a stale id doesn't leak across panes).
  // biome-ignore lint/correctness/useExhaustiveDependencies: convId is the deliberate reset trigger
  useEffect(() => {
    setFocusedId(null)
    setRowCommand(null)
  }, [convId])

  // Report the focused message (id + own-ness) up so chat-app's palette/keys context stays honest.
  const focused = focusable.find((m) => m.id === focusedId) ?? null
  useEffect(() => {
    if (!visible) return
    onFocusChange?.(focused ? { id: focused.id, isOwn: !!focused.self } : null)
  }, [visible, focused, onFocusChange])

  const moveFocus = useCallback(
    (delta: 1 | -1) => {
      setFocusedId((cur) => {
        if (focusable.length === 0) return cur
        const i = cur ? focusable.findIndex((m) => m.id === cur) : -1
        // From no-focus: `next` starts at the newest (last), `prev` at the newest too — j/k both enter
        // at the bottom, the natural reading position in a bottom-anchored thread.
        if (i === -1) return focusable[focusable.length - 1].id
        const next = Math.min(focusable.length - 1, Math.max(0, i + delta))
        return focusable[next].id
      })
    },
    [focusable],
  )

  useImperativeHandle(
    ref,
    (): ThreadHandle => ({
      focusNext: () => moveFocus(1),
      focusPrev: () => moveFocus(-1),
      getFocused: () => (focused ? { id: focused.id, isOwn: !!focused.self } : null),
      command: (type) => {
        // A command with no focused row is a no-op — chat-app gates on getFocused() anyway.
        if (!focusedId) return
        setRowCommand({ type, nonce: Date.now() })
      },
      isComposerFocused: () => composerFocusedRef.current,
    }),
    [moveFocus, focused, focusedId],
  )

  const composer = (
    <div className="shrink-0 border-border border-t px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      {send.phase === "failed" && (
        <p className="pb-1.5 text-destructive text-xs">{sendErrorCopy(send.code)}</p>
      )}
      {(pendingUrl || (pendingFile && !pendingIsImage)) && (
        <div className="pb-2">
          <div className="relative inline-block">
            {pendingUrl ? (
              <img
                alt="Attachment preview"
                className="size-16 rounded-md border border-border object-cover"
                src={pendingUrl}
              />
            ) : (
              <div className="flex max-w-[16rem] items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
                <HugeiconsIcon
                  className="size-4 shrink-0 text-muted-foreground"
                  icon={File01Icon}
                />
                <span className="truncate text-sm">{pendingFile?.name || "file"}</span>
              </div>
            )}
            <button
              aria-label="Remove attachment"
              className="-right-1.5 -top-1.5 absolute flex size-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm hover:bg-accent"
              disabled={send.phase === "sending"}
              onClick={() => setPendingFile(null)}
              type="button"
            >
              <HugeiconsIcon className="size-3" icon={Cancel01Icon} />
            </button>
          </div>
        </div>
      )}
      <div className="flex items-end gap-2">
        <input
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) setPendingFile(f)
            e.target.value = "" // allow re-picking the same file
          }}
          ref={fileRef}
          type="file"
        />
        <Button
          aria-label="Attach file"
          disabled={send.phase === "sending"}
          onClick={() => fileRef.current?.click()}
          size="icon"
          variant="ghost"
        >
          <HugeiconsIcon className="size-4" icon={Attachment01Icon} />
        </Button>
        <textarea
          className="max-h-32 min-h-9 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-base outline-none focus:ring-1 focus:ring-ring"
          disabled={send.phase === "sending"}
          onBlur={() => {
            composerFocusedRef.current = false
          }}
          onChange={(e) => setSend(reduceSend(send, { type: "edit", draft: e.target.value }))}
          onFocus={() => {
            composerFocusedRef.current = true
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              doSend()
            }
          }}
          onPaste={(e) => {
            const file = pickFile(e.clipboardData?.items)
            if (file) {
              e.preventDefault()
              setPendingFile(file)
            }
          }}
          placeholder="Type a message…"
          ref={taRef}
          rows={1}
          value={send.draft}
        />
        <Button
          aria-label={send.phase === "failed" ? "Retry send" : "Send"}
          disabled={send.phase === "sending" || (!send.draft.trim() && !pendingFile)}
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
              className="thread-messages flex min-h-0 flex-1 flex-col-reverse gap-2 overflow-y-auto overscroll-contain px-3 py-3"
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
                  <MessageRow
                    command={m.id === focusedId ? (rowCommand ?? undefined) : undefined}
                    focused={m.id === focusedId}
                    key={m.id}
                    message={m}
                    onDelete={onDelete}
                    onEdit={onEdit}
                    onReact={onReact}
                  />
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
})

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
