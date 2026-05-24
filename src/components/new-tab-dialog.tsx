import { Globe02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { VisuallyHidden } from "radix-ui"
import { useEffect, useRef, useState } from "react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

interface NewTabDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  pins: Pin[]
  onNewTab: (url: string) => void
  onActivatePin: (pin: Pin) => void
}

export function NewTabDialog({
  open,
  onOpenChange,
  pins,
  onNewTab,
  onActivatePin,
}: NewTabDialogProps) {
  const [query, setQuery] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery("")
      // Focus input after dialog animation
      const t = setTimeout(() => inputRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [open])

  const handleSubmit = () => {
    const trimmed = query.trim()
    if (!trimmed) return
    let url = trimmed
    if (!url.match(/^https?:\/\//)) url = `https://${url}`
    onNewTab(url)
    onOpenChange(false)
  }

  const handlePinClick = (pin: Pin) => {
    onActivatePin(pin)
    onOpenChange(false)
  }

  const filtered = query.trim()
    ? pins.filter(
        (p) =>
          p.title.toLowerCase().includes(query.toLowerCase()) ||
          p.url.toLowerCase().includes(query.toLowerCase()),
      )
    : pins

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-[420px] p-0 gap-0 overflow-hidden">
        <VisuallyHidden.Root>
          <DialogTitle>New Tab</DialogTitle>
        </VisuallyHidden.Root>

        {/* URL input */}
        <div className="flex items-center border-b border-border px-4">
          <HugeiconsIcon className="size-4 text-muted-foreground shrink-0" icon={Globe02Icon} />
          <input
            className="flex-1 h-12 px-3 text-sm bg-transparent text-foreground placeholder:text-muted-foreground outline-none"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit()
            }}
            placeholder="Enter URL or search pins..."
            ref={inputRef}
            type="text"
            value={query}
          />
        </div>

        {/* Pinned quick-launch */}
        {filtered.length > 0 && (
          <div className="p-3 max-h-[300px] overflow-y-auto">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground px-1 pb-2 select-none">
              {query.trim() ? "Matches" : "Pinned"}
            </p>
            <div className="space-y-0.5">
              {filtered.map((p) => (
                <button
                  className={cn(
                    "w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-left",
                    "text-foreground hover:bg-accent transition-colors",
                  )}
                  key={p.id}
                  onClick={() => handlePinClick(p)}
                  type="button"
                >
                  <PinFavicon favicon={p.favicon} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{p.title}</p>
                    <p className="text-[10px] text-muted-foreground truncate">{p.url}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Empty state when filtering yields nothing */}
        {query.trim() && filtered.length === 0 && pins.length > 0 && (
          <div className="p-4 text-center text-xs text-muted-foreground">
            No matching pins. Press Enter to open URL.
          </div>
        )}

        {/* Hint when no pins */}
        {pins.length === 0 && (
          <div className="p-4 text-center text-xs text-muted-foreground">
            Type a URL and press Enter to open a new tab.
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function PinFavicon({ favicon }: { favicon?: string }) {
  if (favicon) {
    return (
      <img
        alt=""
        aria-hidden="true"
        className="size-5 rounded shrink-0"
        onError={(e) => {
          ;(e.target as HTMLImageElement).style.display = "none"
        }}
        src={favicon}
      />
    )
  }
  return <HugeiconsIcon className="size-5 shrink-0 text-muted-foreground" icon={Globe02Icon} />
}
