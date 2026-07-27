// The AI assistant panel (t174, ADR-0021 decision 5): a third column beside list+thread on wide,
// a full-screen stacked view on phone. Driven by @ai-sdk/react useChat against the t173 stream
// route. Owned, minimal AI-Elements-style pieces (message list, streamed markdown via Streamdown,
// prompt input) on the shared shadcn design system — Streamdown renders markdown to React elements
// (no raw HTML injection), the same XSS posture as sanitize-message.ts.

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
import { HugeiconsIcon } from "@hugeicons/react"
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
import { cn } from "@/lib/utils"
import { extractCitations } from "../../lib/assistant-citations"
import {
  ASSISTANT_BASE,
  type AssistantSession,
  assistantErrorCode,
  assistantErrorCopy,
  createSession,
  deleteSession,
  listSessions,
  loadSessionMessages,
  patchSession,
} from "../../lib/assistant-client"
import { prompt } from "../prompt-dialog"

export interface AssistantPanelProps {
  /** Active session id (persisted in chat settings); null = pick/create on open. */
  sessionId: string | null
  onSessionChange: (id: string | null) => void
  onClose: () => void
  /** Phone stacked view: show a back affordance instead of the ✕. */
  narrow?: boolean
  /** Conversation label lookup for citation chips. */
  labelForConv: (convId: string) => string
  /** Open a cited conversation in the main pane: `/chat/c/{convId}?msg={msgId}`. */
  onOpenCitation: (convId: string, msgId: string) => void
  /** Bumped by "Ask AI about this" so the active session reloads its messages (a context excerpt
   *  was appended server-side). */
  refreshNonce?: number
}

const SUGGESTED_PROMPTS = [
  "What did I miss today?",
  "Summarize my unread conversations",
  "Tìm tin nhắn về deploy tuần này",
]

export function AssistantPanel(props: AssistantPanelProps) {
  const { sessionId, onSessionChange } = props
  const [sessions, setSessions] = useState<AssistantSession[] | null>(null)
  const [sessionsError, setSessionsError] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

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

  // Load sessions on mount; ensure an active one exists (grilled default: create when none).
  useEffect(() => {
    let alive = true
    refreshSessions().then(async (list) => {
      if (!alive || !list) return
      if (sessionId && list.some((s) => s.id === sessionId)) return
      const first = list[0]
      if (first) {
        onSessionChange(first.id)
        return
      }
      try {
        const created = await createSession()
        if (!alive) return
        setSessions([created])
        onSessionChange(created.id)
      } catch {
        setSessionsError(true)
      }
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot only
  }, [])

  const active = sessions?.find((s) => s.id === sessionId) ?? null

  const newSession = useCallback(async () => {
    try {
      const created = await createSession()
      setSessions((l) => [created, ...(l ?? [])])
      onSessionChange(created.id)
      setPickerOpen(false)
    } catch {
      setSessionsError(true)
    }
  }, [onSessionChange])

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
      if (sessionId === id) onSessionChange(rest[0]?.id ?? null)
    },
    [sessions, sessionId, onSessionChange],
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="titlebar flex h-12 shrink-0 items-center gap-1 border-border border-b px-2">
        {props.narrow && (
          <Button aria-label="Back" onClick={props.onClose} size="icon-sm" variant="ghost">
            <HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
          </Button>
        )}
        <HugeiconsIcon className="size-4 shrink-0 text-muted-foreground" icon={AiChat02Icon} />
        {/* Session picker: newest-updated first, switch/create/rename/delete. */}
        <Popover onOpenChange={setPickerOpen} open={pickerOpen}>
          <PopoverTrigger asChild>
            <button
              className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-2 py-1 text-left text-sm hover:bg-accent"
              type="button"
            >
              <span className="truncate font-medium">
                {active?.title || (active ? "New session" : "Assistant")}
              </span>
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
                <div
                  className={cn(
                    "group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
                    s.id === sessionId && "bg-accent/60",
                  )}
                  key={s.id}
                >
                  <button
                    className="min-w-0 flex-1 truncate text-left"
                    onClick={() => {
                      onSessionChange(s.id)
                      setPickerOpen(false)
                    }}
                    type="button"
                  >
                    {s.title || "New session"}
                    <span className="ml-2 text-[10px] text-muted-foreground">
                      {new Date(s.updatedAt).toLocaleDateString()}
                    </span>
                  </button>
                  <button
                    aria-label="Delete session"
                    className="rounded p-1 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
                    onClick={() => setConfirmDelete(s.id)}
                    type="button"
                  >
                    <HugeiconsIcon className="size-3.5" icon={Delete02Icon} />
                  </button>
                </div>
              ))}
              {sessions?.length === 0 && (
                <div className="px-2 py-3 text-muted-foreground text-xs">No sessions yet</div>
              )}
            </div>
          </PopoverContent>
        </Popover>
        {active && (
          <Button aria-label="Rename session" onClick={renameActive} size="icon-sm" variant="ghost">
            <HugeiconsIcon className="size-4" icon={PencilEdit02Icon} />
          </Button>
        )}
        {!props.narrow && (
          <Button
            aria-label="Close assistant"
            onClick={props.onClose}
            size="icon-sm"
            variant="ghost"
          >
            <HugeiconsIcon className="size-4" icon={Cancel01Icon} />
          </Button>
        )}
      </header>

      {sessionsError && !sessions && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-muted-foreground text-sm">Could not load assistant sessions.</p>
          <Button onClick={() => refreshSessions()} size="sm" variant="outline">
            Retry
          </Button>
        </div>
      )}

      {!sessionsError && sessions === null && <PanelSkeleton />}

      {sessions !== null && sessionId && (
        <SessionChat
          contextRefs={active?.contextRefs ?? []}
          key={`${sessionId}:${props.refreshNonce ?? 0}`}
          labelForConv={props.labelForConv}
          onOpenCitation={props.onOpenCitation}
          sessionId={sessionId}
        />
      )}

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

/** One session's chat surface. Remounted per session (key) so useChat + history re-init cleanly. */
function SessionChat({
  sessionId,
  contextRefs,
  labelForConv,
  onOpenCitation,
}: {
  sessionId: string
  contextRefs: AssistantSession["contextRefs"]
  labelForConv: (convId: string) => string
  onOpenCitation: (convId: string, msgId: string) => void
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
      onOpenCitation={onOpenCitation}
      sessionId={sessionId}
    />
  )
}

function SessionChatReady({
  sessionId,
  initial,
  contextRefs,
  labelForConv,
  onOpenCitation,
}: {
  sessionId: string
  initial: UIMessage[]
  contextRefs: AssistantSession["contextRefs"]
  labelForConv: (convId: string) => string
  onOpenCitation: (convId: string, msgId: string) => void
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
                  key={p}
                  onClick={() => {
                    setInput(p)
                    inputRef.current?.focus()
                  }}
                  type="button"
                >
                  {p}
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
                onOpenCitation={onOpenCitation}
                streaming={busy && m === messages[messages.length - 1]}
              />
            ))}
            {status === "submitted" && (
              <div className="text-muted-foreground text-xs italic">Thinking…</div>
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

      <div className="flex shrink-0 items-end gap-1.5 border-border border-t p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
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
          <Button aria-label="Stop" onClick={() => stop()} size="icon-sm" variant="outline">
            <HugeiconsIcon className="size-4" icon={StopIcon} />
          </Button>
        ) : (
          <Button aria-label="Send" disabled={!input.trim()} onClick={submit} size="icon-sm">
            <HugeiconsIcon className="size-4" icon={ArrowUp01Icon} />
          </Button>
        )}
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
}: {
  message: UIMessage
  streaming: boolean
  labelForConv: (convId: string) => string
  onOpenCitation: (convId: string, msgId: string) => void
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
        <div className="text-[10px] text-muted-foreground italic">
          {streaming && !displayText ? "Searching your messages…" : `Searched ${toolCalls.length}×`}
        </div>
      )}
      {(displayText || streaming) && (
        <div className="teams-message-body max-w-full text-sm [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p+p]:mt-2 [&_ul]:list-disc [&_ul]:pl-5">
          <Streamdown parseIncompleteMarkdown>{displayText}</Streamdown>
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
