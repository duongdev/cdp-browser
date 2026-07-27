// Local edit/delete history of one message (PSN-105 C, grilled decision 2). Teams throws the
// previous version away, so this reads the BFF's own snapshots — the only copy that exists.
//
// A popover, deliberately: the thread is `flex-col-reverse`, so an inline expansion would move
// every bubble around it. Versions are newest→oldest with a relative stamp; the live body is marked
// "current". Prior bodies are site-authored HTML and go through the SAME sanitize() boundary as a
// normal bubble — never raw innerHTML.

import { useCallback, useEffect, useMemo, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { fetchMessageHistory, type MessageHistory } from "../lib/chat-client"
import { relativeTime } from "../lib/conversation-view"
import { sanitize } from "../lib/sanitize-message"

type Load =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "done"; data: MessageHistory }

export function MessageHistoryPopover({
  convId,
  msgId,
  label,
  className,
}: {
  convId: string
  msgId: string
  /** Trigger copy — "(edited)" on a live message, "view original" on a tombstone. */
  label: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [load, setLoad] = useState<Load>({ status: "loading" })

  const run = useCallback(
    (signal?: AbortSignal) => {
      setLoad({ status: "loading" })
      fetchMessageHistory(convId, msgId, signal).then(
        (data) => !signal?.aborted && setLoad({ status: "done", data }),
        (err: unknown) => {
          if (signal?.aborted) return
          setLoad({ status: "error", error: (err as Error)?.message || "failed" })
        },
      )
    },
    [convId, msgId],
  )

  useEffect(() => {
    if (!open) return
    const ac = new AbortController()
    run(ac.signal)
    return () => ac.abort()
  }, [open, run])

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        aria-label="Show this message's version history"
        className={cn(
          "px-1 font-mono text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline",
          className,
        )}
        type="button"
      >
        {label}
      </PopoverTrigger>
      {/* Collision handling, not a fixed alignment: the trigger sits under a RIGHT-aligned own
          message, so a hard `align="start"` pushed the 20rem panel off the window's right edge and
          it got clipped. `align="center"` + a collision padding lets Radix shift it back on-screen
          (and flip sides when the bubble is near the bottom), at phone width too. */}
      <PopoverContent
        align="center"
        className="max-h-80 w-[min(20rem,calc(100vw-2rem))] overflow-y-auto p-0"
        collisionPadding={8}
      >
        <div className="border-border border-b px-3 py-2">
          <p className="font-medium text-xs">Version history</p>
          <p className="text-[11px] text-muted-foreground">
            Kept locally — Teams keeps no previous version.
          </p>
        </div>
        <div className="p-2">
          {load.status === "loading" && (
            <p className="px-1 py-2 text-muted-foreground text-xs">Loading versions…</p>
          )}
          {load.status === "error" && (
            <div className="flex items-center gap-2 px-1 py-2 text-xs">
              <span className="text-destructive">Couldn't load versions.</span>
              <button
                className="font-semibold underline underline-offset-2"
                onClick={() => run()}
                type="button"
              >
                Retry
              </button>
            </div>
          )}
          {load.status === "done" && <Versions data={load.data} />}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function Versions({ data }: { data: MessageHistory }) {
  const now = Date.now()
  if (data.versions.length === 0) {
    return (
      <p className="px-1 py-2 text-muted-foreground text-xs">
        No earlier version was recorded. Only changes seen since this feature shipped are kept.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {data.current && !data.current.deleted && (
        <VersionBlock body={data.current.body} label="current" />
      )}
      {data.versions.map((v, i) => (
        <VersionBlock
          body={v.body}
          // Versions are an append-only list with no stable id; index is the identity here.
          // biome-ignore lint/suspicious/noArrayIndexKey: append-only list, no id
          key={i}
          label={relativeTime(v.editTs ?? v.capturedAt, now) || "earlier"}
        />
      ))}
      {data.truncated && (
        <p className="px-1 text-[11px] text-muted-foreground">
          Older versions past the newest {data.cap} were dropped.
        </p>
      )}
    </div>
  )
}

function VersionBlock({ body, label }: { body: string; label: string }) {
  // XSS BOUNDARY: a prior body is site-authored HTML — sanitize() before it hits the DOM.
  const html = useMemo(() => sanitize(body), [body])
  return (
    <div className="rounded-md bg-muted/60 px-2 py-1.5">
      <span className="font-mono text-[10px] text-muted-foreground">{label}</span>
      <div
        className="teams-message-body text-sm leading-snug [overflow-wrap:anywhere]"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitize() is the XSS boundary (t133)
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
