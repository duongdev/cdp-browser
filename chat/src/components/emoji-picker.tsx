import { useEffect, useRef, useState } from "react"
import { Input } from "@/components/ui/input"
import { filterEmoji, groupByCategory } from "../lib/emoji-catalog"
import { useEmojiCatalog } from "../lib/use-emoji-catalog"

interface Props {
  onSelect: (key: string) => void
  onClose: () => void
}

export function EmojiPicker({ onSelect, onClose }: Props) {
  const catalog = useEmojiCatalog()
  const [query, setQuery] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus the search box once it exists — on the FIRST render the catalog is still loading and
  // there is no input to focus, so a mount-only effect silently never focused anything (PSN-105 L).
  // biome-ignore lint/correctness/useExhaustiveDependencies: catalog is the deliberate re-run trigger — it's what makes the input exist
  useEffect(() => {
    inputRef.current?.focus()
  }, [catalog])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  if (!catalog) {
    return (
      <div className="w-72 h-48 flex items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    )
  }

  const filtered = filterEmoji(catalog.emoji, query)

  return (
    <div className="w-72 flex flex-col gap-2 p-2">
      <Input
        className="h-8 text-sm"
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search emoji…"
        ref={inputRef}
        value={query}
      />
      <div className="max-h-64 overflow-y-auto overflow-x-hidden pr-1">
        {query ? (
          <div className="grid grid-cols-8 gap-0.5">
            {filtered.map((e) => (
              <button
                className="flex min-w-0 items-center justify-center overflow-hidden rounded p-1 text-xl leading-none transition-colors hover:bg-accent"
                key={e.i}
                onClick={() => onSelect(e.i)}
                title={e.d}
                type="button"
              >
                {e.u}
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="col-span-8 text-center text-sm text-muted-foreground py-4">
                No results
              </p>
            )}
          </div>
        ) : (
          Array.from(groupByCategory(catalog.emoji).entries()).map(([catIdx, entries]) => (
            <div className="mb-2" key={catIdx}>
              <p className="text-xs text-muted-foreground px-1 mb-1 sticky top-0 bg-popover">
                {catalog.categories[catIdx] ?? ""}
              </p>
              <div className="grid grid-cols-8 gap-0.5">
                {entries.map((e) => (
                  <button
                    className="flex min-w-0 items-center justify-center overflow-hidden rounded p-1 text-xl leading-none transition-colors hover:bg-accent"
                    key={e.i}
                    onClick={() => onSelect(e.i)}
                    title={e.d}
                    type="button"
                  >
                    {e.u}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
