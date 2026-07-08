import {
  ArrowMoveDownRightIcon,
  CloudIcon,
  Globe02Icon,
  LaptopIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { VisuallyHidden } from "radix-ui"
import { useEffect, useMemo, useRef, useState } from "react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { type OpenTab, suggest } from "@/lib/tab-suggest"
import { cn } from "@/lib/utils"

export type NewTabKind = "cdp" | "local"

const MODE = {
  cdp: {
    label: "CDP tab",
    icon: CloudIcon,
    tint: "text-sky-600 dark:text-sky-400",
    chip: "bg-sky-500/20 text-sky-700 ring-sky-500/40 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-400/30",
    ring: "ring-sky-500/55 focus-within:ring-sky-500/75 dark:ring-sky-400/40 dark:focus-within:ring-sky-400/60",
    pinsLabel: "Pinned",
  },
  local: {
    label: "Local tab",
    icon: LaptopIcon,
    tint: "text-emerald-600 dark:text-emerald-400",
    chip: "bg-emerald-500/20 text-emerald-700 ring-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-400/30",
    ring: "ring-emerald-500/55 focus-within:ring-emerald-500/75 dark:ring-emerald-400/40 dark:focus-within:ring-emerald-400/60",
    pinsLabel: "Local tabs",
  },
} as const

interface NewTabDialogProps {
  open: boolean
  /** Seeds the mode each time the dialog opens (the active tab's kind, else cdp). */
  initialKind: NewTabKind
  onOpenChange: (open: boolean) => void
  cdpPins: Pin[]
  localPins: Pin[]
  /** Electron only: when false the local mode + Tab-to-switch are hidden (web build). */
  localEnabled: boolean
  /** Currently-open tabs (CDP + local) — matched for the "Switch to tab" suggestion (t103). */
  openTabs: OpenTab[]
  onOpenUrl: (kind: NewTabKind, url: string) => void
  onActivatePin: (kind: NewTabKind, pin: Pin) => void
  onSwitchTab: (kind: "cdp" | "local", id: string) => void
}

export function NewTabDialog({
  open,
  initialKind,
  onOpenChange,
  cdpPins,
  localPins,
  localEnabled,
  openTabs,
  onOpenUrl,
  onActivatePin,
  onSwitchTab,
}: NewTabDialogProps) {
  const [kind, setKind] = useState<NewTabKind>(initialKind)
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(0)
  const [history, setHistory] = useState<HistoryVisit[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  // Seed mode + reset on each open. Web (no local) is always pinned to cdp. Load the
  // browsing history once per open — it feeds the omnibox suggestions (t103).
  useEffect(() => {
    if (open) {
      setKind(localEnabled ? initialKind : "cdp")
      setQuery("")
      setSelected(0)
      window.cdp
        .getHistory?.()
        .then((h) => setHistory(h ?? []))
        .catch(() => setHistory([]))
      const t = setTimeout(() => inputRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [open, initialKind, localEnabled])

  const mode = MODE[kind]
  const pins = kind === "cdp" ? cdpPins : localPins
  const trimmed = query.trim()

  const filteredPins = useMemo(() => {
    if (!trimmed) return pins
    const q = trimmed.toLowerCase()
    return pins.filter((p) => p.title.toLowerCase().includes(q) || p.url.toLowerCase().includes(q))
  }, [pins, trimmed])

  // History + open-tab suggestions for the typed query (t103). Empty query returns [].
  const suggestions = useMemo(
    () => suggest({ query: trimmed, history, openTabs, now: Date.now(), limit: 8 }),
    [trimmed, history, openTabs],
  )

  // Row model. Empty query: pins only. Typing: the "open URL" row, then switch/history
  // suggestions, then matching pins.
  type Item =
    | { kind: "url"; url: string }
    | { kind: "pin"; pin: Pin }
    | { kind: "switch"; tabKind: "cdp" | "local"; id: string; title: string; url: string }
    | { kind: "history"; title: string; url: string }
  const items = useMemo<Item[]>(() => {
    const list: Item[] = []
    if (trimmed) {
      list.push({ kind: "url", url: trimmed })
      for (const s of suggestions) list.push(s)
    }
    for (const p of filteredPins) list.push({ kind: "pin", pin: p })
    return list
  }, [trimmed, suggestions, filteredPins])

  // Keep the selection in range as items change.
  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, items.length - 1)))
  }, [items.length])

  const run = (item: Item | undefined) => {
    if (!item) {
      if (trimmed) onOpenUrl(kind, normalizeUrl(trimmed))
      onOpenChange(false)
      return
    }
    if (item.kind === "url") onOpenUrl(kind, normalizeUrl(item.url))
    else if (item.kind === "switch") onSwitchTab(item.tabKind, item.id)
    else if (item.kind === "history") onOpenUrl(kind, item.url)
    else onActivatePin(kind, item.pin)
    onOpenChange(false)
  }

  // All keys handled on the input so it never loses focus (arrows + Tab + Enter).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Tab" && localEnabled) {
      e.preventDefault()
      setKind((k) => (k === "cdp" ? "local" : "cdp"))
      setSelected(0)
      return
    }
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSelected((s) => (items.length ? (s + 1) % items.length : 0))
      return
    }
    if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelected((s) => (items.length ? (s - 1 + items.length) % items.length : 0))
      return
    }
    if (e.key === "Enter") {
      e.preventDefault()
      run(items[selected])
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[460px]" showCloseButton={false}>
        <VisuallyHidden.Root>
          <DialogTitle>New {mode.label}</DialogTitle>
        </VisuallyHidden.Root>

        {/* input — mode shown by the leading icon + accent ring + chip (no segment bar) */}
        <div
          className={cn(
            "m-3 mb-2 flex items-center gap-2.5 rounded-xl bg-foreground/[0.04] px-3 ring-2 transition-all",
            mode.ring,
          )}
        >
          <HugeiconsIcon className={cn("size-4 shrink-0", mode.tint)} icon={mode.icon} />
          <input
            className="h-11 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`Open a new ${mode.label} — URL or search…`}
            ref={inputRef}
            type="text"
            value={query}
          />
          <span
            className={cn(
              "shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium ring-1",
              mode.chip,
            )}
          >
            {mode.label}
          </span>
        </div>

        <div className="max-h-[300px] overflow-y-auto px-3 pb-2">
          {!(trimmed && filteredPins.length === 0) && (
            <p className="select-none px-1 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/55">
              {trimmed ? "Suggestions" : mode.pinsLabel}
            </p>
          )}
          <div className="space-y-0.5">
            {items.map((item, i) => {
              const isSel = i === selected
              return (
                <button
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors touch-target",
                    isSel ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.04]",
                  )}
                  key={
                    item.kind === "url"
                      ? "__url"
                      : item.kind === "pin"
                        ? `pin:${item.pin.id}`
                        : item.kind === "switch"
                          ? `switch:${item.tabKind}:${item.id}`
                          : `hist:${item.url}`
                  }
                  onClick={() => run(item)}
                  onMouseMove={() => setSelected(i)}
                  type="button"
                >
                  {item.kind === "url" && (
                    <>
                      <HugeiconsIcon
                        className="size-4 shrink-0 text-muted-foreground"
                        icon={Globe02Icon}
                      />
                      <span className="min-w-0 flex-1 truncate text-[13px]">
                        Open <span className="text-foreground">{item.url}</span>
                      </span>
                    </>
                  )}
                  {item.kind === "switch" && (
                    <>
                      <HugeiconsIcon
                        className="size-4 shrink-0 text-muted-foreground"
                        icon={ArrowMoveDownRightIcon}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px]">{item.title || item.url}</span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          Switch to tab · {stripScheme(item.url)}
                        </span>
                      </span>
                    </>
                  )}
                  {item.kind === "history" && (
                    <>
                      <HugeiconsIcon
                        className="size-4 shrink-0 text-muted-foreground"
                        icon={Globe02Icon}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px]">{item.title || item.url}</span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {stripScheme(item.url)}
                        </span>
                      </span>
                    </>
                  )}
                  {item.kind === "pin" && (
                    <>
                      <PinFavicon favicon={item.pin.favicon} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px]">{item.pin.title}</span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {item.pin.url}
                        </span>
                      </span>
                    </>
                  )}
                  {isSel && (
                    <kbd className="shrink-0 rounded border border-border/70 bg-foreground/[0.06] px-1 font-mono text-[10px] text-muted-foreground">
                      ↵
                    </kbd>
                  )}
                </button>
              )
            })}
          </div>
          {items.length === 0 && (
            <p className="px-1 py-3 text-center text-xs text-muted-foreground">
              Type a URL and press Enter.
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-border/60 px-3.5 py-2 text-[11px] text-muted-foreground/60">
          {localEnabled && <Hint k="Tab">switch mode</Hint>}
          <Hint k="↑↓">navigate</Hint>
          <Hint k="↵">open</Hint>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Hint({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1">
      <kbd className="rounded border border-border/70 bg-foreground/[0.06] px-1 font-mono text-[10px]">
        {k}
      </kbd>
      {children}
    </span>
  )
}

function PinFavicon({ favicon }: { favicon?: string }) {
  if (favicon) {
    return (
      <img
        alt=""
        aria-hidden="true"
        className="size-5 shrink-0 rounded"
        onError={(e) => {
          ;(e.target as HTMLImageElement).style.display = "none"
        }}
        src={favicon}
      />
    )
  }
  return <HugeiconsIcon className="size-5 shrink-0 text-muted-foreground" icon={Globe02Icon} />
}

function normalizeUrl(input: string) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`
}

function stripScheme(url: string) {
  return url.replace(/^[a-z]+:\/\//i, "")
}
