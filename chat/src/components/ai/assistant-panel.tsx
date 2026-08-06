// The AI assistant panel (t174 + steering pass, ADR-0021 decision 5): a third column beside
// list+thread on wide, a full-screen stacked view on phone. Two pages — a session LIST (new
// session + rows) and a session VIEW (chat) — with the header AI mark swapping to a back arrow in
// the view, plus a dropdown for quick switching. Opened sessions stay mounted (visible-hidden,
// MRU cap) so switching preserves stream/scroll/draft state, mirroring the thread keep-alive.
// Streamed markdown renders via Streamdown (React elements, no raw HTML — sanitize-message.ts
// posture). All icon buttons carry shadcn Tooltips; no italic styling anywhere.

import { useChat } from "@ai-sdk/react"
import {
  AiChipIcon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUp02Icon,
  Cancel01Icon,
  Copy01Icon,
  Delete02Icon,
  Folder01Icon,
  MessageMultiple01Icon,
  PencilEdit02Icon,
  PenToolAddIcon,
  PlusSignIcon,
  Search01Icon,
  StopIcon,
  Tag01Icon,
  Tick01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { DefaultChatTransport, type UIMessage } from "ai"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Streamdown } from "streamdown"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { usePointerCoarse } from "@/hooks/use-pointer-coarse"
import { cn } from "@/lib/utils"
import { actionItemsPrompt, catchUpPrompt } from "../../lib/assistant-actions"
import {
  citationChipLabel,
  citationKey,
  collectCitationMeta,
  extractCitations,
} from "../../lib/assistant-citations"
import {
  ASSISTANT_BASE,
  type AssistantContextRef,
  type AssistantModel,
  type AssistantScopes,
  type AssistantSession,
  assistantErrorCode,
  assistantErrorCopy,
  createSession,
  deleteSession,
  listModels,
  listSessions,
  loadSessionMessages,
  patchSession,
} from "../../lib/assistant-client"
import { labelMarkdownLinks } from "../../lib/link-label"
import { COMPOSER_FOOTER, ComposerShell } from "../composer-shell"
import { useCopy, useLinkHoverCopy } from "../link-hover-copy"
import { prompt } from "../prompt-dialog"
import { ContextMeter } from "./context-meter"
import { ContextTray } from "./context-tray"
import { ModelSelector } from "./model-selector"
import { ShimmerText } from "./shimmer-text"
import { ToolCalls, type ToolPart } from "./tool-calls"

export interface AssistantPanelProps {
  /** Active session id (persisted in chat settings); null = show the session list. */
  sessionId: string | null
  onSessionChange: (id: string | null) => void
  onClose: () => void
  /** Phone stacked view: the list page's close affordance becomes a back arrow. */
  narrow?: boolean
  /** Conversation label lookup for citation chips. */
  labelForConv: (convId: string) => string
  /** Open a cited conversation in the main pane: `/chat/c/{convId}?msg={msgId}`. */
  onOpenCitation: (convId: string, msgId: string) => void
  /** Open the full-screen message search (PSN-115 WS-E) — a search icon at the panel-header top. */
  onOpenSearch?: () => void
  /** Bumped by "Ask AI about this" so the active session reloads its messages (a context excerpt
   *  was appended server-side). */
  refreshNonce?: number
  /** A quick action's canned prompt (t176) — auto-sent into the active session once. */
  pendingPrompt?: { text: string; nonce: number } | null
  /** Insert assistant-drafted text into the active thread's composer — never auto-sent (t176). */
  onInsertToComposer?: (text: string) => void
  /** The conversation the user is viewing — offered by the "+" menu as "Attach current chat".
   *  It is NOT auto-attached and never silently scopes a turn (grilled): an empty tray means the
   *  assistant searches everything. */
  currentConv?: { convId: string; title: string } | null
  /** Attach the current conversation to the active session. */
  onAttachCurrent?: () => void
  /** The user's own folders + labels, offered by the "+" menu as attachable scopes (PSN-104). */
  scopes?: AssistantScopes
  /** Attach a whole folder/label as a live scope. */
  onAttachScope?: (kind: "folder" | "label", name: string) => void
  /** Detach a ref from the active session. */
  onDetach?: (ref: AssistantContextRef) => void
  /** Jump to a ref in the main pane. */
  onOpenRef?: (ref: AssistantContextRef) => void
  /** The live tray contents, owned by chat-app so add/remove render instantly. Null = fall back to
   *  the session's stored refs (e.g. right after switching sessions). */
  contextRefs?: AssistantContextRef[] | null
}

const SUGGESTED_PROMPTS: { label: string; text: string }[] = [
  { label: "What did I miss?", text: catchUpPrompt() },
  { label: "Action items for me", text: actionItemsPrompt() },
  { label: "Tìm tin nhắn về deploy tuần này", text: "Tìm tin nhắn về deploy tuần này" },
]

/** Keep this many opened session panes mounted (MRU) — same idea as the thread keep-alive. */
const SESSION_KEEPALIVE_CAP = 4

function IconButton({
  label,
  icon,
  onClick,
  destructive,
  className,
}: {
  label: string
  icon: IconSvgElement
  onClick: () => void
  destructive?: boolean
  className?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className={cn(
            "text-muted-foreground",
            destructive && "hover:text-destructive",
            className,
          )}
          onClick={onClick}
          size="icon-sm"
          variant="ghost"
        >
          <HugeiconsIcon className="size-4" icon={icon} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function AssistantPanel(props: AssistantPanelProps) {
  const { sessionId, onSessionChange } = props
  const [sessions, setSessions] = useState<AssistantSession[] | null>(null)
  const [sessionsError, setSessionsError] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  // Two pages: the session list and the session view (steering). Booting with a persisted active
  // session lands directly in its view.
  const [page, setPage] = useState<"list" | "session">(sessionId ? "session" : "list")
  // Curated model list (t177): null = loading, [] = hidden (error/unconfigured/single handled in
  // the selector). Fetched once per panel mount.
  const [models, setModels] = useState<AssistantModel[] | null>(null)
  // Opened sessions stay mounted (visible-hidden) so a switch preserves state — MRU, capped.
  const [mounted, setMounted] = useState<string[]>(sessionId ? [sessionId] : [])

  const refreshSessions = useCallback(async () => {
    try {
      const list = await listSessions()
      setSessions(list)
      setSessionsError(false)
      return list
    } catch {
      setSessionsError(true)
      return null
    }
  }, [])

  useEffect(() => {
    refreshSessions()
    listModels()
      .then(setModels)
      .catch(() => setModels([]))
  }, [refreshSessions])

  const active = sessions?.find((s) => s.id === sessionId) ?? null

  const openSession = useCallback(
    (id: string) => {
      onSessionChange(id)
      setPage("session")
      setPickerOpen(false)
      setMounted((m) => {
        const rest = m.filter((x) => x !== id)
        return [...rest, id].slice(-SESSION_KEEPALIVE_CAP)
      })
    },
    [onSessionChange],
  )

  const newSession = useCallback(async () => {
    try {
      const created = await createSession()
      setSessions((l) => [created, ...(l ?? [])])
      openSession(created.id)
    } catch {
      setSessionsError(true)
    }
  }, [openSession])

  const renameActive = useCallback(async () => {
    if (!active) return
    const name = await prompt({
      title: "Rename session",
      description: "",
      initialValue: active.title ?? "",
      placeholder: "Session title",
    })
    if (name === null) return
    const updated = await patchSession(active.id, { title: name.trim() || "" }).catch(() => null)
    if (updated) setSessions((l) => (l ?? []).map((s) => (s.id === updated.id ? updated : s)))
  }, [active])

  const doDelete = useCallback(
    async (id: string) => {
      await deleteSession(id).catch(() => {})
      const rest = (sessions ?? []).filter((s) => s.id !== id)
      setSessions(rest)
      setMounted((m) => m.filter((x) => x !== id))
      if (sessionId === id) {
        onSessionChange(null)
        setPage("list")
      }
    },
    [sessions, sessionId, onSessionChange],
  )

  // Per-session model pick (t177): persists on the session row, applies from the next turn.
  const pickModel = useCallback(async (id: string, modelId: string) => {
    const updated = await patchSession(id, { model: modelId }).catch(() => null)
    if (updated) setSessions((l) => (l ?? []).map((s) => (s.id === updated.id ? updated : s)))
  }, [])

  const defaultModelId = models?.find((m) => m.default)?.id

  const inSession = page === "session" && !!sessionId

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full min-h-0 flex-col">
        <header className="titlebar flex h-12 shrink-0 items-center gap-1 border-border border-b px-2">
          {inSession ? (
            // Session view: the AI mark yields to a back arrow (steering).
            <IconButton
              icon={ArrowLeft01Icon}
              label="All sessions"
              onClick={() => setPage("list")}
            />
          ) : props.narrow ? (
            <IconButton icon={ArrowLeft01Icon} label="Back" onClick={props.onClose} />
          ) : (
            <HugeiconsIcon
              className="mx-1.5 size-4 shrink-0 text-muted-foreground"
              icon={AiChipIcon}
            />
          )}
          {inSession ? (
            // Quick-switch dropdown stays in the session view (steering).
            <Popover onOpenChange={setPickerOpen} open={pickerOpen}>
              <PopoverTrigger asChild>
                <button
                  className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1 text-left text-sm hover:bg-accent"
                  type="button"
                >
                  <span className="truncate font-medium">{active?.title || "New session"}</span>
                  <HugeiconsIcon
                    className="size-3.5 shrink-0 text-muted-foreground"
                    icon={ArrowDown01Icon}
                  />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72 p-1">
                <button
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                  onClick={newSession}
                  type="button"
                >
                  <HugeiconsIcon className="size-4" icon={PlusSignIcon} />
                  New session
                </button>
                <div className="my-1 border-border border-t" />
                <div className="max-h-72 overflow-y-auto">
                  {/* Two lines (steering): the title owns the full width, model + date drop to a
                      quiet second row instead of squeezing the title from the right. */}
                  {(sessions ?? []).map((s) => (
                    <button
                      className={cn(
                        "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                        s.id === sessionId && "bg-accent/60",
                      )}
                      key={s.id}
                      onClick={() => openSession(s.id)}
                      type="button"
                    >
                      <span className="w-full truncate">{s.title || "New session"}</span>
                      <span className="flex w-full min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
                        {s.model && s.model !== defaultModelId && (
                          <span className="min-w-0 truncate">{s.model}</span>
                        )}
                        {s.model && s.model !== defaultModelId && <span aria-hidden>·</span>}
                        <span className="shrink-0">
                          {new Date(s.updatedAt).toLocaleDateString()}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          ) : (
            <span className="flex-1 font-medium text-sm">Assistant</span>
          )}
          {inSession && active && (
            <IconButton icon={PencilEdit02Icon} label="Rename session" onClick={renameActive} />
          )}
          {!inSession && (
            <IconButton icon={PlusSignIcon} label="New session" onClick={newSession} />
          )}
          {/* Search-icon entry to the full-screen message search (PSN-115 WS-E). Always visible
              so the user can jump out to search from anywhere in the panel. */}
          {props.onOpenSearch && (
            <IconButton icon={Search01Icon} label="Search messages" onClick={props.onOpenSearch} />
          )}
          {(!props.narrow || inSession) && (
            <IconButton icon={Cancel01Icon} label="Close assistant" onClick={props.onClose} />
          )}
        </header>

        {/* ---- session list page ---- */}
        <div className={cn("min-h-0 flex-1 flex-col", inSession ? "hidden" : "flex")}>
          {sessionsError && !sessions && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <p className="text-muted-foreground text-sm">Could not load assistant sessions.</p>
              <Button onClick={() => refreshSessions()} size="sm" variant="outline">
                Retry
              </Button>
            </div>
          )}
          {!sessionsError && sessions === null && <PanelSkeleton />}
          {sessions !== null && sessions.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
              <HugeiconsIcon className="size-8 text-muted-foreground/50" icon={AiChipIcon} />
              <p className="text-muted-foreground text-sm">
                Ask about your messages — search, summarize, catch up. Answers cite the real
                messages they come from.
              </p>
              <Button onClick={newSession} size="sm">
                <HugeiconsIcon className="size-4" icon={PlusSignIcon} />
                New session
              </Button>
            </div>
          )}
          {sessions !== null && sessions.length > 0 && (
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {sessions.map((s) => (
                <div
                  className="group flex items-center gap-1 rounded-lg px-2 py-2 hover:bg-accent"
                  key={s.id}
                >
                  <button
                    className="min-w-0 flex-1 text-left"
                    onClick={() => openSession(s.id)}
                    type="button"
                  >
                    <div className="truncate font-medium text-sm">{s.title || "New session"}</div>
                    <div className="text-muted-foreground text-xs">
                      {new Date(s.updatedAt).toLocaleString()}
                    </div>
                  </button>
                  <IconButton
                    className="opacity-0 group-hover:opacity-100"
                    destructive
                    icon={Delete02Icon}
                    label="Delete session"
                    onClick={() => setConfirmDelete(s.id)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ---- session view page: kept-alive panes, only the active one visible ---- */}
        {mounted.map((id) => (
          <div
            className={cn(
              "min-h-0 flex-1 flex-col",
              inSession && id === sessionId ? "flex" : "hidden",
            )}
            key={id}
          >
            <SessionChat
              contextRefs={
                (id === sessionId ? props.contextRefs : null) ??
                (sessions?.find((s) => s.id === id) ?? null)?.contextRefs ??
                []
              }
              currentConv={props.currentConv}
              labelForConv={props.labelForConv}
              models={models}
              onAttachCurrent={props.onAttachCurrent}
              onAttachScope={props.onAttachScope}
              onDetach={props.onDetach}
              onInsertToComposer={props.onInsertToComposer}
              onOpenCitation={props.onOpenCitation}
              onOpenRef={props.onOpenRef}
              onPickModel={(modelId) => pickModel(id, modelId)}
              pendingPrompt={id === sessionId ? props.pendingPrompt : undefined}
              refreshNonce={props.refreshNonce}
              scopes={props.scopes}
              sessionId={id}
              sessionModel={(sessions?.find((s) => s.id === id) ?? null)?.model ?? null}
            />
          </div>
        ))}

        <AlertDialog onOpenChange={(v) => !v && setConfirmDelete(null)} open={!!confirmDelete}>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete session?</AlertDialogTitle>
              <AlertDialogDescription>
                The conversation with the assistant is removed. Your chat messages are untouched.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (confirmDelete) doDelete(confirmDelete)
                  setConfirmDelete(null)
                }}
                variant="destructive"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  )
}

function PanelSkeleton() {
  return (
    <div className="flex-1 space-y-3 p-4">
      <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
      <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
      <div className="h-4 w-3/5 animate-pulse rounded bg-muted" />
    </div>
  )
}

/** One session's chat surface. Stays mounted while in the keep-alive set. */
function SessionChat({
  sessionId,
  contextRefs,
  labelForConv,
  onOpenCitation,
  pendingPrompt,
  onInsertToComposer,
  models,
  sessionModel,
  onPickModel,
  currentConv,
  onAttachCurrent,
  scopes,
  onAttachScope,
  onDetach,
  onOpenRef,
  refreshNonce,
}: {
  sessionId: string
  contextRefs: AssistantSession["contextRefs"]
  labelForConv: (convId: string) => string
  onOpenCitation: (convId: string, msgId: string) => void
  pendingPrompt?: { text: string; nonce: number } | null
  onInsertToComposer?: (text: string) => void
  models: AssistantModel[] | null
  sessionModel: string | null
  onPickModel: (modelId: string) => void
  currentConv?: { convId: string; title: string } | null
  onAttachCurrent?: () => void
  scopes?: AssistantScopes
  onAttachScope?: (kind: "folder" | "label", name: string) => void
  onDetach?: (ref: AssistantContextRef) => void
  onOpenRef?: (ref: AssistantContextRef) => void
  refreshNonce?: number
}) {
  const [initial, setInitial] = useState<UIMessage[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    loadSessionMessages(sessionId)
      .then((r) => {
        if (alive) setInitial(r.messages as UIMessage[])
      })
      .catch((e) => {
        if (alive) setLoadError(assistantErrorCode(e))
      })
    return () => {
      alive = false
    }
  }, [sessionId])

  if (loadError) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-muted-foreground text-sm">
        {assistantErrorCopy(loadError)}
      </div>
    )
  }
  if (initial === null) return <PanelSkeleton />
  return (
    <SessionChatReady
      contextRefs={contextRefs}
      currentConv={currentConv}
      initial={initial}
      labelForConv={labelForConv}
      models={models}
      onAttachCurrent={onAttachCurrent}
      onAttachScope={onAttachScope}
      onDetach={onDetach}
      onInsertToComposer={onInsertToComposer}
      onOpenCitation={onOpenCitation}
      onOpenRef={onOpenRef}
      onPickModel={onPickModel}
      pendingPrompt={pendingPrompt}
      refreshNonce={refreshNonce}
      scopes={scopes}
      sessionId={sessionId}
      sessionModel={sessionModel}
    />
  )
}

/** The compaction threshold the server actually applies (t173) — what the meter measures against
 *  when the provider doesn't report the model's real window. */
const COMPACT_BUDGET_TOKENS = 40_000

/** Tokens the panel measures against: the active model's REAL context window when the provider
 *  reports one (steering), else the server's compaction threshold. */
export function contextBudgetFor(model: AssistantModel | undefined): number {
  return model?.contextWindow && model.contextWindow > 0
    ? model.contextWindow
    : COMPACT_BUDGET_TOKENS
}

function estimateTokens(messages: UIMessage[]): number {
  let chars = 0
  for (const m of messages) {
    for (const p of m.parts as { text?: string; output?: unknown; input?: unknown }[]) {
      if (typeof p?.text === "string") chars += p.text.length
      if (p?.output !== undefined) chars += JSON.stringify(p.output)?.length ?? 0
      if (p?.input !== undefined) chars += JSON.stringify(p.input)?.length ?? 0
    }
  }
  return Math.ceil(chars / 4)
}

function SessionChatReady({
  sessionId,
  initial,
  contextRefs,
  labelForConv,
  onOpenCitation,
  pendingPrompt,
  onInsertToComposer,
  models,
  sessionModel,
  onPickModel,
  currentConv,
  onAttachCurrent,
  scopes,
  onAttachScope,
  onDetach,
  onOpenRef,
  refreshNonce,
}: {
  sessionId: string
  initial: UIMessage[]
  contextRefs: AssistantSession["contextRefs"]
  labelForConv: (convId: string) => string
  onOpenCitation: (convId: string, msgId: string) => void
  pendingPrompt?: { text: string; nonce: number } | null
  onInsertToComposer?: (text: string) => void
  models: AssistantModel[] | null
  sessionModel: string | null
  onPickModel: (modelId: string) => void
  currentConv?: { convId: string; title: string } | null
  onAttachCurrent?: () => void
  scopes?: AssistantScopes
  onAttachScope?: (kind: "folder" | "label", name: string) => void
  onDetach?: (ref: AssistantContextRef) => void
  onOpenRef?: (ref: AssistantContextRef) => void
  refreshNonce?: number
}) {
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `${ASSISTANT_BASE}/${sessionId}`,
        // The server runs in UTC; "today" means the user's day. Send the browser's own zone with
        // every turn so the assistant doesn't call this morning "yesterday" (PSN-104).
        body: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      }),
    [sessionId],
  )
  const { messages, setMessages, sendMessage, status, error, stop, regenerate, clearError } =
    useChat({
      id: sessionId,
      messages: initial,
      transport,
    })
  const [input, setInput] = useState("")
  // Stop is now an explicit signal, not an inferred one (t179). A Hermes turn deliberately
  // outlives its socket so a user who navigates away comes back to a finished answer — which
  // means closing the stream can no longer double as "cancel". `stop()` alone would leave the
  // agent running invisibly, so the intent is sent out-of-band first, then the local stream
  // is closed. Fire-and-forget: a failed signal must not leave the UI stuck in `busy`.
  const stopTurn = useCallback(() => {
    fetch(`${ASSISTANT_BASE}/${sessionId}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => {})
    stop()
  }, [sessionId, stop])
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // Autofocus on open / new session (steering) — wide pointers only; a phone would pop the keyboard.
  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) inputRef.current?.focus()
  }, [])
  const busy = status === "submitted" || status === "streaming"
  const activeModel = useMemo(() => {
    const def = models?.find((m) => m.default) ?? models?.[0]
    return (sessionModel ? models?.find((m) => m.id === sessionModel) : undefined) ?? def
  }, [models, sessionModel])
  const contextBudget = contextBudgetFor(activeModel)
  // Which scopes are already in the tray — the "+" menu ticks those rows.
  const attachedScopes = useMemo(
    () =>
      new Set(
        contextRefs
          .filter((r) => r.kind === "folder" || r.kind === "label")
          .map((r) => `${r.kind}:${r.name}`),
      ),
    [contextRefs],
  )
  // Menu rows TOGGLE (steering): a ticked row detaches instead of sitting there inert, and the
  // popover stays open so several can be picked in one visit.
  const toggleScope = useCallback(
    (kind: "folder" | "label", name: string) => {
      const existing = contextRefs.find((r) => r.kind === kind && r.name === name)
      if (existing) onDetach?.(existing)
      else onAttachScope?.(kind, name)
    },
    [contextRefs, onDetach, onAttachScope],
  )
  const toggleCurrentConv = useCallback(() => {
    const existing =
      currentConv && contextRefs.find((r) => r.convId === currentConv.convId && !r.msgId)
    if (existing) onDetach?.(existing)
    else onAttachCurrent?.()
  }, [contextRefs, currentConv, onDetach, onAttachCurrent])
  const contextPct = useMemo(
    () => Math.min(100, Math.round((estimateTokens(messages) / contextBudget) * 100)),
    [messages, contextBudget],
  )
  // Scroll-to-bottom affordance (steering): shown whenever the log is scrolled off the bottom.
  const [offBottom, setOffBottom] = useState(false)
  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (el) setOffBottom(el.scrollHeight - el.scrollTop - el.clientHeight > 80)
  }, [])
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [])

  // Stick to bottom while streaming / on new messages.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on any message change
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, status])

  const submit = useCallback(() => {
    const text = input.trim()
    if (!text || busy) return
    setInput("")
    sendMessage({ text })
  }, [input, busy, sendMessage])

  // "Ask AI about this" appended a context excerpt server-side. Re-read the stored messages IN
  // PLACE (never a remount — that used to abort the in-flight stream and re-fire the auto-send,
  // which looked like the assistant hanging forever). Skipped while a turn is streaming.
  const seenRefreshRef = useRef(refreshNonce ?? 0)
  useEffect(() => {
    const n = refreshNonce ?? 0
    if (n === seenRefreshRef.current) return
    seenRefreshRef.current = n
    if (busy) return
    loadSessionMessages(sessionId)
      .then((r) => setMessages(r.messages as UIMessage[]))
      .catch(() => {})
  }, [refreshNonce, busy, sessionId, setMessages])

  // A quick action's canned prompt auto-sends once per nonce (t176) — visible in history like any
  // other user message.
  const sentNonceRef = useRef(0)
  useEffect(() => {
    if (!pendingPrompt || pendingPrompt.nonce === sentNonceRef.current) return
    sentNonceRef.current = pendingPrompt.nonce
    sendMessage({ text: pendingPrompt.text })
  }, [pendingPrompt, sendMessage])

  const empty = messages.length === 0

  return (
    <>
      <div className="relative min-h-0 flex-1">
        <div
          className="h-full overflow-y-auto overflow-x-hidden px-3 py-3"
          onScroll={onScroll}
          ref={scrollRef}
        >
          {empty ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 px-3 text-center">
              <HugeiconsIcon className="size-8 text-muted-foreground/50" icon={AiChipIcon} />
              <p className="text-muted-foreground text-sm">
                Ask about your messages — search, summarize, catch up. Answers cite the real
                messages they come from.
              </p>
              <div className="flex flex-col gap-2">
                {SUGGESTED_PROMPTS.map((p) => (
                  <button
                    className="rounded-full border border-border px-3 py-1.5 text-muted-foreground text-sm hover:bg-accent"
                    key={p.label}
                    onClick={() => {
                      setInput(p.text)
                      inputRef.current?.focus()
                    }}
                    type="button"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex min-w-0 flex-col gap-3">
              {messages.map((m) => (
                <AssistantMessage
                  key={m.id}
                  labelForConv={labelForConv}
                  message={m}
                  onInsertToComposer={onInsertToComposer}
                  onOpenCitation={onOpenCitation}
                  streaming={busy && m === messages[messages.length - 1]}
                />
              ))}
              {status === "submitted" && (
                <div className="text-xs">
                  <ShimmerText>Thinking…</ShimmerText>
                </div>
              )}
            </div>
          )}
        </div>
        <Button
          aria-label="Scroll to bottom"
          className={cn(
            "absolute right-3 bottom-3 z-10 rounded-full shadow-md transition-all duration-200",
            offBottom
              ? "translate-y-0 opacity-70 hover:opacity-100"
              : "pointer-events-none translate-y-2 opacity-0",
          )}
          onClick={scrollToBottom}
          size="icon-sm"
          variant="secondary"
        >
          <HugeiconsIcon className="size-4" icon={ArrowDown01Icon} />
        </Button>
      </div>

      {error && (
        <div className="mx-3 mb-2 flex items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs">
          <span>{assistantErrorCopy(assistantErrorCode(error))}</span>
          <Button
            onClick={() => {
              clearError()
              regenerate()
            }}
            size="sm"
            variant="outline"
          >
            Retry
          </Button>
        </div>
      )}

      <ContextTray
        onOpen={(r) => onOpenRef?.(r)}
        onRemove={(r) => onDetach?.(r)}
        refs={contextRefs}
      />

      <ComposerShell>
        <>
          <textarea
            className="ai-composer-input block max-h-48 min-h-[2.5rem] w-full resize-none bg-transparent px-3.5 py-2.5 outline-none placeholder:text-muted-foreground"
            onChange={(e) => {
              setInput(e.target.value)
              const el = e.target
              el.style.height = "auto"
              el.style.height = `${Math.min(el.scrollHeight, 192)}px`
            }}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter and ⌥Enter insert a newline (multi-line support).
              if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder="Ask about your messages…"
            ref={inputRef}
            rows={1}
            value={input}
          />
          <div className={COMPOSER_FOOTER}>
            <AttachMenu
              alreadyAttached={
                !!currentConv &&
                contextRefs.some((r) => r.convId === currentConv.convId && !r.msgId)
              }
              attachedScopes={attachedScopes}
              currentConv={currentConv}
              onToggleCurrent={toggleCurrentConv}
              onToggleScope={toggleScope}
              scopes={scopes}
            />
            <ModelSelector models={models} onPick={onPickModel} sessionModel={sessionModel} />
            <ContextMeter
              budgetTokens={contextBudget}
              exact={!!activeModel?.contextWindow}
              loading={models === null}
              pct={contextPct}
            />
            <div className="flex-1" />
            {busy ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label="Stop"
                    onClick={() => stopTurn()}
                    size="icon-sm"
                    variant="outline"
                  >
                    <HugeiconsIcon className="size-4" icon={StopIcon} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Stop generating</TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label="Send"
                    disabled={!input.trim()}
                    onClick={submit}
                    size="icon-sm"
                  >
                    <HugeiconsIcon className="size-4" icon={ArrowUp02Icon} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Send (↵)</TooltipContent>
              </Tooltip>
            )}
          </div>
        </>
      </ComposerShell>
    </>
  )
}

/** One row in the "+" menu. Shared so the current-chat row and the scope rows can't drift apart. */
const MENU_ROW =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent disabled:pointer-events-none"

/** The tick column — always occupies its width, so a row's label and count stay put whether or not
 *  it's already attached. */
function TickSlot({ on }: { on?: boolean }) {
  return (
    <span aria-hidden className="flex w-3.5 shrink-0 justify-center">
      {on && <HugeiconsIcon className="size-3.5 text-muted-foreground" icon={Tick01Icon} />}
    </span>
  )
}

/** The "+" attach menu (grilled): the only way a whole chat enters the tray from the panel.
 *  Messages are attached from the thread's ⋯ menu, and other conversations by navigating to them
 *  first — deliberately no picker here. */
function AttachMenu({
  currentConv,
  alreadyAttached,
  onToggleCurrent,
  scopes,
  attachedScopes,
  onToggleScope,
}: {
  currentConv?: { convId: string; title: string } | null
  alreadyAttached: boolean
  /** Attach the current conversation, or detach it when it's already ticked. */
  onToggleCurrent?: () => void
  scopes?: AssistantScopes
  attachedScopes?: Set<string>
  /** Attach the scope, or detach it when it's already ticked. */
  onToggleScope?: (kind: "folder" | "label", name: string) => void
}) {
  const [open, setOpen] = useState(false)
  const folders = scopes?.folders ?? []
  const labels = scopes?.labels ?? []
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button aria-label="Attach context" size="icon-sm" variant="ghost">
              <HugeiconsIcon className="size-4" icon={PlusSignIcon} />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Attach context</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-64 p-1" side="top">
        <button
          className={cn(MENU_ROW, !currentConv && "opacity-50 hover:bg-transparent")}
          disabled={!currentConv}
          onClick={onToggleCurrent}
          type="button"
        >
          <HugeiconsIcon className="size-4 shrink-0" icon={MessageMultiple01Icon} />
          <span className="min-w-0 flex-1 truncate">
            {currentConv ? `Attach "${currentConv.title}"` : "Attach current chat"}
          </span>
          <TickSlot on={alreadyAttached} />
        </button>
        {/* Folders + labels attach as SCOPES (PSN-104): the chip holds the name, and membership is
            resolved per question, so a chat filed into the folder later is already in scope. */}
        {(folders.length > 0 || labels.length > 0) && (
          <div className="mt-1 max-h-64 overflow-y-auto border-border border-t pt-1">
            {[
              ...folders.map((s) => ({ ...s, kind: "folder" as const })),
              ...labels.map((s) => ({ ...s, kind: "label" as const })),
            ].map((s) => {
              const on = attachedScopes?.has(`${s.kind}:${s.name}`)
              return (
                <button
                  aria-pressed={on}
                  className={MENU_ROW}
                  key={`${s.kind}:${s.name}`}
                  onClick={() => onToggleScope?.(s.kind, s.name)}
                  type="button"
                >
                  <HugeiconsIcon
                    className="size-4 shrink-0"
                    icon={s.kind === "folder" ? Folder01Icon : Tag01Icon}
                  />
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  {/* Fixed-width count + a permanently reserved tick slot: the numbers line up in
                      one column and a row doesn't shift when it becomes attached (steering). */}
                  <span className="w-5 shrink-0 text-right text-muted-foreground text-xs tabular-nums">
                    {s.count}
                  </span>
                  <TickSlot on={on} />
                </button>
              )
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** One UIMessage: user right/accent, assistant markdown left with citation chips + tool activity. */
function AssistantMessage({
  message,
  streaming,
  labelForConv,
  onOpenCitation,
  onInsertToComposer,
}: {
  message: UIMessage
  streaming: boolean
  labelForConv: (convId: string) => string
  onOpenCitation: (convId: string, msgId: string) => void
  onInsertToComposer?: (text: string) => void
}) {
  const isUser = message.role === "user"
  // Marker rows (a model switch) are notes about the conversation, not turns in it. Everything
  // below branches on `isUser`, so without this a system row would render as a full assistant
  // bubble — avatar, copy button, insert-to-composer — and read as something the assistant
  // said. Keyed off metadata, never the text, so a user cannot forge one by typing it.
  const marker = (message.metadata as { kind?: string } | undefined)?.kind === "model-change"
  const text = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n\n")
  const toolCalls = message.parts.filter(
    (p) => typeof p.type === "string" && (p.type.startsWith("tool-") || p.type === "dynamic-tool"),
  )
  // Reasoning models (GLM) stream a long reasoning phase before any text — live-measured at ~15s
  // with 70+ reasoning deltas. Without a marker the turn renders as a blank gap and reads as a
  // hang (steering: "freezes forever"), so an in-flight turn with no text yet always shows a
  // live state.
  const reasoning = message.parts
    .filter((p): p is { type: "reasoning"; text: string } => p.type === "reasoning")
    .map((p) => p.text)
    .join("")
  const { text: displayText, citations } = useMemo(() => extractCitations(text), [text])
  // Sender + excerpt for each cited id, harvested from this turn's own tool rows (no extra fetch).
  const citeMeta = useMemo(() => collectCitationMeta(message.parts), [message.parts])
  // Bare URLs in the answer get the SAME label the chat bubbles give them (PR chip / middle-elide),
  // rewritten in the markdown source so Streamdown still owns the anchor and its safety modal.
  const markdown = useMemo(() => labelMarkdownLinks(displayText), [displayText])
  // Sources stay collapsed — a long chip list buried the answer (steering).
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const coarse = usePointerCoarse()
  const linkCopy = useLinkHoverCopy(!coarse)
  const [copied, copyAnswer] = useCopy()
  // "3 messages in 2 chats" reads as evidence; "3 sources" doesn't say what was cited (steering).
  const sourcesLabel = useMemo(() => {
    const chats = new Set(citations.map((c) => c.convId)).size
    const m = `${citations.length} ${citations.length === 1 ? "message" : "messages"}`
    return `${m} in ${chats} ${chats === 1 ? "chat" : "chats"}`
  }, [citations])

  // A marker row is a divider, not a turn: centred, muted, no avatar and no actions, so it
  // reads as something that HAPPENED to the conversation rather than something said in it.
  if (marker) {
    return (
      <div className="flex items-center gap-2 self-center py-1 text-muted-foreground text-xs">
        <span className="h-px w-6 bg-border" />
        <span>{text}</span>
        <span className="h-px w-6 bg-border" />
      </div>
    )
  }

  // The user bubble is the SAME one the thread renders for your own messages —
  // `teams-message-body` carries the radius/padding and `teams-self-bubble` the low-glare dark-mode
  // fill, so light AND dark match the chat instead of a hand-rolled copy that only matched light.
  if (isUser) {
    return (
      <div
        className="teams-self-bubble teams-message-body ml-8 max-w-full self-end bg-primary px-3 py-2 text-primary-foreground text-sm leading-snug [overflow-wrap:anywhere]"
        data-pos="solo"
        data-side="self"
      >
        <span className="whitespace-pre-wrap break-words">{text}</span>
      </div>
    )
  }
  return (
    <div className="group flex min-w-0 max-w-full flex-col gap-1.5 self-start pr-4">
      <ToolCalls parts={toolCalls as ToolPart[]} streaming={streaming && !displayText} />
      {streaming && !displayText && (
        <div className="text-xs">
          <ShimmerText>{reasoning ? "Thinking it through…" : "Working…"}</ShimmerText>
        </div>
      )}
      {displayText && (
        <div className="relative min-w-0 max-w-full">
          {/* Link hover-copy is a fine-pointer affordance; links stay Tab-reachable natively. */}
          <div className="ai-message-body min-w-0 max-w-full" {...linkCopy.bodyProps}>
            {/* linkSafety off (steering: "the external link modal is broken"): with it on,
                Streamdown renders a <button> that pops an interstitial and carries NO href — so a
                link in an answer behaved differently from the identical link in a message bubble,
                and neither the PR chip (an href CSS selector) nor hover-copy could see it. Off, it
                emits a real target=_blank anchor, exactly like a chat message's link. */}
            <Streamdown linkSafety={{ enabled: false }} parseIncompleteMarkdown>
              {markdown}
            </Streamdown>
          </div>
          {linkCopy.overlay}
        </div>
      )}
      {!streaming && !displayText && toolCalls.length > 0 && (
        <div className="text-muted-foreground text-xs">
          No answer came back for that — try rephrasing, or ask for a narrower time range.
        </div>
      )}
      {citations.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1">
          <button
            aria-expanded={sourcesOpen}
            className="inline-flex w-fit items-center gap-1 rounded-md text-muted-foreground text-xs hover:text-foreground"
            onClick={() => setSourcesOpen((v) => !v)}
            type="button"
          >
            {/* Disclosure chevron, same as the sidebar folders + attach tray: right → down. */}
            <HugeiconsIcon
              className={cn("size-3.5 transition-transform", sourcesOpen && "rotate-90")}
              icon={ArrowRight01Icon}
            />
            {sourcesLabel}
          </button>
          {sourcesOpen && (
            <div className="flex max-h-48 min-w-0 flex-col gap-1 overflow-y-auto">
              {citations.map((c) => {
                const meta = citeMeta.get(citationKey(c))
                return (
                  <button
                    className="flex min-w-0 max-w-full flex-col gap-0.5 rounded-lg border border-border bg-accent/40 px-2.5 py-1.5 text-left text-xs hover:bg-accent"
                    key={`${c.convId}:${c.msgId}`}
                    onClick={() => onOpenCitation(c.convId, c.msgId)}
                    title={`Open in ${labelForConv(c.convId)}`}
                    type="button"
                  >
                    <span className="min-w-0 truncate text-foreground">
                      {citationChipLabel(meta, labelForConv(c.convId))}
                    </span>
                    <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                      ↗ {labelForConv(c.convId)}
                      {meta?.ts ? ` · ${new Date(meta.ts).toLocaleString()}` : ""}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}
      {/* Message actions live in a hover-revealed row under the answer (ChatGPT-style) instead of
          a permanently visible button that competed with the answer text. */}
      {!streaming && displayText && (
        <div className="-ml-1.5 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {onInsertToComposer && (
            <IconButton
              icon={PenToolAddIcon}
              label="Insert into composer"
              onClick={() => onInsertToComposer(displayText)}
            />
          )}
          <IconButton
            icon={copied ? Tick01Icon : Copy01Icon}
            label={copied ? "Copied" : "Copy response"}
            onClick={() => copyAnswer(displayText)}
          />
        </div>
      )}
    </div>
  )
}
