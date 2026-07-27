// The AI assistant panel (t174 + steering pass, ADR-0021 decision 5): a third column beside
// list+thread on wide, a full-screen stacked view on phone. Two pages — a session LIST (new
// session + rows) and a session VIEW (chat) — with the header AI mark swapping to a back arrow in
// the view, plus a dropdown for quick switching. Opened sessions stay mounted (visible-hidden,
// MRU cap) so switching preserves stream/scroll/draft state, mirroring the thread keep-alive.
// Streamed markdown renders via Streamdown (React elements, no raw HTML — sanitize-message.ts
// posture). All icon buttons carry shadcn Tooltips; no italic styling anywhere.

import { useChat } from "@ai-sdk/react"
import {
  AiChat02Icon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Delete02Icon,
  PencilEdit02Icon,
  PlusSignIcon,
  StopIcon,
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
import { cn } from "@/lib/utils"
import { extractCitations } from "../../lib/assistant-citations"
import {
  ASSISTANT_BASE,
  type AssistantModel,
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
import { prompt } from "../prompt-dialog"
import { ModelSelector } from "./model-selector"

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
  /** Bumped by "Ask AI about this" so the active session reloads its messages (a context excerpt
   *  was appended server-side). */
  refreshNonce?: number
  /** A quick action's canned prompt (t176) — auto-sent into the active session once. */
  pendingPrompt?: { text: string; nonce: number } | null
  /** Insert assistant-drafted text into the active thread's composer — never auto-sent (t176). */
  onInsertToComposer?: (text: string) => void
}

import { actionItemsPrompt, catchUpPrompt } from "../../lib/assistant-actions"

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
              icon={AiChat02Icon}
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
                  {(sessions ?? []).map((s) => (
                    <button
                      className={cn(
                        "flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                        s.id === sessionId && "bg-accent/60",
                      )}
                      key={s.id}
                      onClick={() => openSession(s.id)}
                      type="button"
                    >
                      <span className="min-w-0 flex-1 truncate">{s.title || "New session"}</span>
                      {s.model && s.model !== defaultModelId && (
                        <span className="ml-2 max-w-24 shrink-0 truncate rounded bg-accent px-1 text-[9px] text-muted-foreground">
                          {s.model}
                        </span>
                      )}
                      <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">
                        {new Date(s.updatedAt).toLocaleDateString()}
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
              <HugeiconsIcon className="size-8 text-muted-foreground/50" icon={AiChat02Icon} />
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
                    <div className="text-[11px] text-muted-foreground">
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
            key={`${id}:${props.refreshNonce ?? 0}`}
          >
            <SessionChat
              contextRefs={(sessions?.find((s) => s.id === id) ?? null)?.contextRefs ?? []}
              labelForConv={props.labelForConv}
              models={models}
              onInsertToComposer={props.onInsertToComposer}
              onOpenCitation={props.onOpenCitation}
              onPickModel={(modelId) => pickModel(id, modelId)}
              pendingPrompt={id === sessionId ? props.pendingPrompt : undefined}
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
      initial={initial}
      labelForConv={labelForConv}
      models={models}
      onInsertToComposer={onInsertToComposer}
      onOpenCitation={onOpenCitation}
      onPickModel={onPickModel}
      pendingPrompt={pendingPrompt}
      sessionId={sessionId}
      sessionModel={sessionModel}
    />
  )
}

/** ~4 chars per token, measured against the same 40K budget the server compacts at (t173). */
const CONTEXT_BUDGET_TOKENS = 40_000

function estimateContextPct(messages: UIMessage[]): number {
  let chars = 0
  for (const m of messages) {
    for (const p of m.parts as { text?: string; output?: unknown; input?: unknown }[]) {
      if (typeof p?.text === "string") chars += p.text.length
      if (p?.output !== undefined) chars += JSON.stringify(p.output)?.length ?? 0
      if (p?.input !== undefined) chars += JSON.stringify(p.input)?.length ?? 0
    }
  }
  return Math.min(100, Math.round((chars / 4 / CONTEXT_BUDGET_TOKENS) * 100))
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
}) {
  const transport = useMemo(
    () => new DefaultChatTransport({ api: `${ASSISTANT_BASE}/${sessionId}` }),
    [sessionId],
  )
  const { messages, sendMessage, status, error, stop, regenerate, clearError } = useChat({
    id: sessionId,
    messages: initial,
    transport,
  })
  const [input, setInput] = useState("")
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const busy = status === "submitted" || status === "streaming"
  const contextPct = useMemo(() => estimateContextPct(messages), [messages])

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
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" ref={scrollRef}>
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-3 text-center">
            <HugeiconsIcon className="size-8 text-muted-foreground/50" icon={AiChat02Icon} />
            <p className="text-muted-foreground text-sm">
              Ask about your messages — search, summarize, catch up. Answers cite the real messages
              they come from.
            </p>
            <div className="flex flex-col gap-2">
              {SUGGESTED_PROMPTS.map((p) => (
                <button
                  className="rounded-full border border-border px-3 py-1.5 text-muted-foreground text-xs hover:bg-accent"
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
          <div className="flex flex-col gap-3">
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
              <div className="text-muted-foreground text-xs">Thinking…</div>
            )}
          </div>
        )}
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

      {contextRefs.length > 0 && (
        <div className="flex flex-wrap gap-1 px-3 pb-1">
          {contextRefs.map((r) => (
            <span
              className="rounded-full bg-accent px-2 py-0.5 text-[10px] text-muted-foreground"
              key={`${r.convId}:${r.msgId ?? ""}`}
              title={r.title}
            >
              ⤷ {r.title}
            </span>
          ))}
        </div>
      )}

      <div className="shrink-0 border-border border-t p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="flex items-end gap-1.5">
          <textarea
            className="max-h-40 min-h-9 flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-ring"
            onChange={(e) => {
              setInput(e.target.value)
              const el = e.target
              el.style.height = "auto"
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder="Ask about your messages…"
            ref={inputRef}
            rows={1}
            value={input}
          />
          {busy ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button aria-label="Stop" onClick={() => stop()} size="icon-sm" variant="outline">
                  <HugeiconsIcon className="size-4" icon={StopIcon} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Stop</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button aria-label="Send" disabled={!input.trim()} onClick={submit} size="icon-sm">
                  <HugeiconsIcon className="size-4" icon={ArrowUp01Icon} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Send</TooltipContent>
            </Tooltip>
          )}
        </div>
        {/* Footer: model picker (t177, Copilot placement) + context-window usage (steering). */}
        <div className="mt-1 flex items-center gap-1.5 px-1">
          <ModelSelector models={models} onPick={onPickModel} sessionModel={sessionModel} />
          <div className="flex-1" />
          <div className="h-1 w-16 overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full", contextPct >= 80 ? "bg-destructive" : "bg-ring")}
              style={{ width: `${Math.max(2, contextPct)}%` }}
            />
          </div>
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {contextPct}% context
          </span>
        </div>
      </div>
    </>
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
  const text = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n\n")
  const toolCalls = message.parts.filter(
    (p) => typeof p.type === "string" && (p.type.startsWith("tool-") || p.type === "dynamic-tool"),
  )
  const { text: displayText, citations } = useMemo(() => extractCitations(text), [text])

  if (isUser) {
    return (
      <div className="ml-8 self-end rounded-2xl rounded-br-md bg-primary px-3 py-2 text-primary-foreground text-sm">
        <span className="whitespace-pre-wrap break-words">{text}</span>
      </div>
    )
  }
  return (
    <div className="mr-4 flex flex-col gap-1.5 self-start">
      {toolCalls.length > 0 && (
        <div className="text-[10px] text-muted-foreground">
          {streaming && !displayText ? "Searching your messages…" : `Searched ${toolCalls.length}×`}
        </div>
      )}
      {(displayText || streaming) && (
        <div className="teams-message-body max-w-full text-sm [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p+p]:mt-2 [&_ul]:list-disc [&_ul]:pl-5">
          <Streamdown parseIncompleteMarkdown>{displayText}</Streamdown>
        </div>
      )}
      {!streaming && displayText && onInsertToComposer && (
        <div>
          <button
            className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => onInsertToComposer(displayText)}
            type="button"
          >
            Insert into composer
          </button>
        </div>
      )}
      {citations.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {citations.map((c) => (
            <button
              className="max-w-56 truncate rounded-full border border-border bg-accent/50 px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              key={`${c.convId}:${c.msgId}`}
              onClick={() => onOpenCitation(c.convId, c.msgId)}
              title={`Open in ${labelForConv(c.convId)}`}
              type="button"
            >
              ↗ {labelForConv(c.convId)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
