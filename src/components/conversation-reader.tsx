import { ArrowLeft01Icon, GlobalIcon, ReloadIcon, SentIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useCallback, useEffect, useState } from "react"
import { AdapterIcon } from "@/components/adapter-icon"
import type { NotifEntry } from "@/components/notification-bell"
import { Button } from "@/components/ui/button"
import { slackGroupLabel } from "@/lib/notifications-view"
import { type ReaderRoute, readerRoute } from "@/lib/reader"
import { reduceSend, type SendState, selectReplyTarget } from "@/lib/slack-reply"
import { cn } from "@/lib/utils"

type FetchHistory = NonNullable<Window["cdp"]["getSlackHistory"]>
type SendReply = NonNullable<Window["cdp"]["sendSlackReply"]>

interface Props {
  entry: NotifEntry
  onBack: () => void
  /** The screencast escape hatch — today's activation path (switch tab + deep-open). */
  onOpenInBrowser: (entry: NotifEntry) => void
  /** window.cdp.getSlackHistory when the build has it; absent → stub detail. */
  fetchHistory?: FetchHistory
  /** window.cdp.sendSlackReply when the build has it; absent → read-only reader. */
  sendReply?: SendReply
}

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; code: string }
  | { phase: "ready"; messages: ReaderMessage[] }

// Honest failure copy (t077): say why and what fixes it — the phone user can't
// re-extract creds by hand; the parked-tab keeper does it on its own schedule.
function errorCopy(code: string): string {
  if (code === "invalid_auth")
    return "Slack session expired — it refreshes itself when the parked Slack tab reloads. Retry in a minute."
  if (code === "rate_limited") return "Slack is rate-limiting requests — wait a moment and retry."
  return "Couldn't load the conversation."
}

function sendErrorCopy(code: string): string {
  if (code === "invalid_auth")
    return "Not sent — Slack session expired. It refreshes itself; retry in a minute."
  if (code === "rate_limited") return "Not sent — rate-limited. Wait a moment and retry."
  return "Not sent — your text is kept above. Retry, or send it from the desktop."
}

function timeLabel(tsMs: number): string {
  const d = new Date(tsMs)
  const sameDay = new Date().toDateString() === d.toDateString()
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  return sameDay ? hm : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${hm}`
}

/**
 * The Conversation Reader (t077, ADR-0012): a phone-native detail view rendered from
 * captured content, never Screencast Frames. Slack entries with a channel identity load
 * one rendered history page; everything else shows the stub detail (the captured toast
 * text). "Open in browser" is the explicit screencast escape hatch.
 */
export function ConversationReader({
  entry,
  onBack,
  onOpenInBrowser,
  fetchHistory,
  sendReply,
}: Props) {
  const route: ReaderRoute = readerRoute(entry, !!fetchHistory)
  const team = route.kind === "history" ? route.team : null
  const channel = route.kind === "history" ? route.channel : null
  const [state, setState] = useState<LoadState>({ phase: "loading" })
  // Retry re-runs the fetch effect without changing the conversation identity.
  const [retryTick, setRetryTick] = useState(0)
  const retry = useCallback(() => setRetryTick((t) => t + 1), [])

  // Composer (t078): text-only, synchronous + honest — no outbox. The reply target is
  // chosen once per send by the single policy owner (selectReplyTarget).
  const replyTarget = selectReplyTarget(entry)
  const canReply = route.kind === "history" && !!sendReply && !!replyTarget
  const [send, setSend] = useState<SendState>({ phase: "idle", draft: "" })
  const doSend = useCallback(() => {
    if (!sendReply || !team || !replyTarget) return
    const text = send.draft.trim()
    const next = reduceSend(send, { type: "send" })
    setSend(next)
    if (next.phase !== "sending") return
    sendReply({ team, channel: replyTarget.channel, thread_ts: replyTarget.thread_ts, text })
      .then((out) => {
        if (out?.ok) {
          setSend((s) => reduceSend(s, { type: "ok" }))
          // Show the sent message in place — no second history fetch (429 budget).
          setState((s) =>
            s.phase === "ready"
              ? {
                  phase: "ready",
                  messages: [
                    ...s.messages,
                    {
                      ts: out.ts ?? `sent-${Date.now()}`,
                      tsMs: Date.now(),
                      senderName: "You",
                      body: text,
                      self: true,
                      threadTs: replyTarget.thread_ts ?? null,
                    },
                  ],
                }
              : s,
          )
        } else {
          setSend((s) => reduceSend(s, { type: "fail", code: out?.error ?? "send_failed" }))
        }
      })
      .catch(() => setSend((s) => reduceSend(s, { type: "fail", code: "network_error" })))
  }, [send, sendReply, team, replyTarget])

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryTick is the deliberate manual refetch trigger
  useEffect(() => {
    if (!team || !channel || !fetchHistory) return
    let cancelled = false
    setState({ phase: "loading" })
    fetchHistory({ team, channel })
      .then((out) => {
        if (cancelled) return
        if (out?.messages) setState({ phase: "ready", messages: out.messages })
        else setState({ phase: "error", code: out?.error ?? "bad_response" })
      })
      .catch(() => {
        if (!cancelled) setState({ phase: "error", code: "network_error" })
      })
    return () => {
      cancelled = true
    }
  }, [team, channel, retryTick, fetchHistory])

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
        <Button
          aria-label="Back to Inbox"
          className="text-muted-foreground"
          onClick={onBack}
          size="icon-xs"
          variant="ghost"
        >
          <HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
          <AdapterIcon className="size-4 shrink-0 rounded-sm" entry={entry} />
          <div className="flex min-w-0 flex-col">
            <span className="min-w-0 truncate text-sm font-medium leading-tight">
              {slackGroupLabel(entry) ?? entry.title ?? entry.source}
            </span>
            {/* Which workspace this conversation lives in (t082) — Slack only. */}
            {entry.adapter === "slack" && entry.source && (
              <span className="min-w-0 truncate text-[10px] leading-tight text-muted-foreground">
                {entry.source}
                {entry.slackKind === "im"
                  ? " · DM"
                  : entry.slackKind === "mpim"
                    ? " · Group DM"
                    : entry.slackThreadTs
                      ? " · thread"
                      : ""}
              </span>
            )}
          </div>
        </div>
        <Button
          aria-label="Open in browser"
          className="text-muted-foreground"
          onClick={() => onOpenInBrowser(entry)}
          size="icon-xs"
          variant="ghost"
        >
          <HugeiconsIcon className="size-4" icon={GlobalIcon} />
        </Button>
      </header>

      {route.kind === "stub" ? (
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <p className="text-sm leading-relaxed break-words [overflow-wrap:anywhere]">
            {entry.body || entry.title}
          </p>
          <p className="text-xs text-muted-foreground">
            {entry.source} · {timeLabel(entry.ts)}
          </p>
          <Button
            className="self-start"
            onClick={() => onOpenInBrowser(entry)}
            size="sm"
            variant="outline"
          >
            Open in browser
          </Button>
        </div>
      ) : state.phase === "loading" ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading conversation…
        </div>
      ) : state.phase === "error" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-sm text-muted-foreground">{errorCopy(state.code)}</p>
          <Button onClick={retry} size="sm" variant="outline">
            <HugeiconsIcon className="size-3.5" icon={ReloadIcon} />
            Retry
          </Button>
        </div>
      ) : state.messages.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          No recent messages
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-4 py-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {state.messages.map((m) => (
            <div className="flex flex-col gap-0.5" key={m.ts}>
              <div className="flex items-baseline gap-2">
                <span className={cn("text-xs font-semibold", m.self && "text-primary")}>
                  {m.self ? "You" : m.senderName}
                </span>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {timeLabel(m.tsMs)}
                </span>
              </div>
              <p className="text-sm leading-snug break-words [overflow-wrap:anywhere]">{m.body}</p>
            </div>
          ))}
        </div>
      )}

      {/* Composer (t078): text-only; failure keeps the draft in the box (no outbox). */}
      {canReply && (
        <div className="shrink-0 border-t border-border px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {send.phase === "failed" && (
            <p className="pb-1.5 text-xs text-destructive">{sendErrorCopy(send.code)}</p>
          )}
          <div className="flex items-end gap-2">
            <textarea
              className="max-h-32 min-h-9 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              disabled={send.phase === "sending"}
              onChange={(e) => setSend(reduceSend(send, { type: "edit", draft: e.target.value }))}
              placeholder="Reply…"
              rows={1}
              value={send.draft}
            />
            <Button
              aria-label={send.phase === "failed" ? "Retry send" : "Send"}
              disabled={send.phase === "sending" || !send.draft.trim()}
              onClick={doSend}
              size="icon-xs"
            >
              <HugeiconsIcon className="size-4" icon={SentIcon} />
            </Button>
          </div>
          {send.phase === "sending" && (
            <p className="pt-1 text-[11px] text-muted-foreground">Sending…</p>
          )}
        </div>
      )}
    </div>
  )
}
