import { type RefObject, useEffect, useState } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/** A shadcn tooltip for names baked into sanitized message HTML (PSN-92 E). Mention pills and reply-
 *  quote authors carry `data-fullname` when the Names setting shortened them (`formatBodyNames`), but
 *  they're rendered via dangerouslySetInnerHTML, so they can't be React tooltip triggers. This host
 *  delegates: it watches `containerRef` for a hover over any `[data-fullname]` and anchors ONE Radix
 *  tooltip (a zero-interaction fixed trigger moved to the hovered rect) over it — the real shadcn
 *  tooltip, not a title attr. Fine-pointer only; a coarse pointer has no hover and the pill is short. */
export function BodyNameTooltip({ containerRef }: { containerRef: RefObject<HTMLElement | null> }) {
  const [tip, setTip] = useState<{
    text: string
    x: number
    y: number
    w: number
    h: number
  } | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const named = (t: EventTarget | null) =>
      t instanceof Element ? (t.closest("[data-fullname]") as HTMLElement | null) : null
    const onOver = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return
      const hit = named(e.target)
      if (!hit) return
      const full = hit.getAttribute("data-fullname") || ""
      if (!full) return
      const r = hit.getBoundingClientRect()
      setTip({ text: full, x: r.left, y: r.top, w: r.width, h: r.height })
    }
    const onOut = (e: PointerEvent) => {
      if (named(e.target)) setTip(null)
    }
    // Any scroll invalidates the anchored rect — drop the tooltip rather than let it drift.
    const onScroll = () => setTip(null)
    el.addEventListener("pointerover", onOver)
    el.addEventListener("pointerout", onOut)
    el.addEventListener("scroll", onScroll, true)
    return () => {
      el.removeEventListener("pointerover", onOver)
      el.removeEventListener("pointerout", onOut)
      el.removeEventListener("scroll", onScroll, true)
    }
  }, [containerRef])

  if (!tip) return null
  return (
    <Tooltip open>
      <TooltipTrigger asChild>
        <span
          aria-hidden
          style={{
            position: "fixed",
            left: tip.x,
            top: tip.y,
            width: tip.w,
            height: tip.h,
            pointerEvents: "none",
          }}
        />
      </TooltipTrigger>
      <TooltipContent side="top">{tip.text}</TooltipContent>
    </Tooltip>
  )
}
