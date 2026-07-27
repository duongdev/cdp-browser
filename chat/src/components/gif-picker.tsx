import { useEffect, useRef, useState } from "react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { type GifItem, type GiphyKind, searchGiphy } from "../lib/teams-gif"

interface Props {
  kind: GiphyKind
  onSelect: (item: GifItem) => void
  onClose: () => void
}

/** GIF / sticker picker (PSN-94 D/E): a search box over the BFF Giphy proxy + a 2-column grid.
 *  Empty query shows trending. Picking sends immediately (the parent shapes it into an OutgoingMessage
 *  and fires onSend). Mirrors emoji-picker's shell — debounced search, loading / empty states. */
export function GifPicker({ kind, onSelect, onClose }: Props) {
  const [query, setQuery] = useState("")
  const [items, setItems] = useState<GifItem[] | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  // Debounced search; a fresh keystroke aborts the in-flight fetch.
  useEffect(() => {
    const ctl = new AbortController()
    setItems(null)
    const t = setTimeout(() => {
      searchGiphy(kind, query.trim(), ctl.signal).then((r) => {
        if (!ctl.signal.aborted) setItems(r)
      })
    }, 250)
    return () => {
      clearTimeout(t)
      ctl.abort()
    }
  }, [kind, query])

  return (
    <div className="flex w-72 flex-col gap-2 p-2">
      <Input
        className="h-8 text-sm"
        onChange={(e) => setQuery(e.target.value)}
        placeholder={kind === "stickers" ? "Search stickers…" : "Search GIFs…"}
        ref={inputRef}
        value={query}
      />
      <div className="max-h-64 overflow-y-auto pr-1">
        {items === null ? (
          <p className="py-6 text-center text-muted-foreground text-sm">Loading…</p>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-muted-foreground text-sm">
            No results. Set GIPHY_API_KEY on the server to enable search.
          </p>
        ) : (
          <div className="columns-2 gap-1">
            {items.map((it) => (
              <button
                className={cn(
                  "mb-1 block w-full overflow-hidden rounded-md border border-transparent",
                  "transition-colors hover:border-ring/50",
                )}
                key={it.id}
                onClick={() => onSelect(it)}
                type="button"
              >
                <img
                  alt=""
                  className="w-full bg-muted/40"
                  loading="lazy"
                  src={it.previewUrl}
                  style={{ aspectRatio: `${it.width} / ${it.height}` }}
                />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
