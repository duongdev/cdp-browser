// Hover a link → a small copy button parks at its end (PSN-99). Extracted from message-row so the
// assistant's answers get the identical affordance (PSN-104 steering) instead of a second copy of
// the hover-bridge timing, which is the fiddly part: the button floats a few px off the link, so
// leaving the link starts a short grace timer that entering the button cancels.
//
// Fine pointer only — a coarse pointer has no hover, and long-press already belongs to the OS.

import { Copy01Icon, Tick01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useCallback, useEffect, useRef, useState } from "react"

/** Copy `text` to clipboard; briefly flip to a "copied" tick for ~1.2 s. */
export function useCopy(): [copied: boolean, copy: (text: string) => void] {
  const [copied, setCopied] = useState(false)
  const t = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (t.current) clearTimeout(t.current)
    },
    [],
  )
  const copy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      if (t.current) clearTimeout(t.current)
      t.current = setTimeout(() => setCopied(false), 1200)
    })
  }, [])
  return [copied, copy]
}

/** Wire a rendered message body for link hover-copy. Spread `bodyProps` on the element that holds
 *  the links and render `overlay` as its sibling. `enabled` false (coarse pointer) → both are inert. */
export function useLinkHoverCopy(enabled: boolean) {
  const [hovered, setHovered] = useState<{ href: string; rect: DOMRect } | null>(null)
  const [copied, copy] = useCopy()
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelHide = useCallback(() => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current)
      hideTimer.current = null
    }
  }, [])
  const scheduleHide = useCallback(() => {
    cancelHide()
    hideTimer.current = setTimeout(() => setHovered(null), 180)
  }, [cancelHide])
  useEffect(() => cancelHide, [cancelHide])

  const onMouseOver = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const a = (e.target as HTMLElement).closest?.("a[href]") as HTMLAnchorElement | null
      if (a?.href) {
        cancelHide()
        setHovered({ href: a.href, rect: a.getBoundingClientRect() })
      } else {
        scheduleHide()
      }
    },
    [cancelHide, scheduleHide],
  )

  const bodyProps = enabled ? { onMouseOver, onMouseOut: scheduleHide } : {}

  // FIXED at the hovered link's own end, overlapping the last few px so it sits INSIDE the link's
  // soft highlight (no reserved layout space), vertically centered on the link's line, clamped to
  // the viewport's right edge.
  const overlay =
    enabled && hovered ? (
      <button
        className="link-copy-btn fixed z-30 flex size-5 items-center justify-center rounded-md border border-border bg-background/95 text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-accent hover:text-foreground"
        onClick={(e) => {
          e.preventDefault()
          copy(hovered.href)
        }}
        onMouseEnter={cancelHide}
        onMouseLeave={scheduleHide}
        style={{
          top: Math.max(2, hovered.rect.top + Math.min(hovered.rect.height, 22) / 2 - 10),
          left: Math.min(hovered.rect.right - 6, window.innerWidth - 24),
        }}
        title="Copy link"
        type="button"
      >
        <HugeiconsIcon className="size-3" icon={copied ? Tick01Icon : Copy01Icon} />
      </button>
    ) : null

  return { bodyProps, overlay }
}
