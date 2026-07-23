import { Cancel01Icon, Download04Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import {
  applyPinch,
  IDENTITY,
  isZoomed,
  type Point,
  panBy,
  type ViewSize,
  type ZoomState,
  zoomAround,
} from "../lib/lightbox-zoom"

/** What the lightbox is showing. `kind` picks the surface: a zoomable image or a native video
 *  player. Downloads use `src` directly (same-origin proxy → forced save). */
export interface LightboxMedia {
  src: string
  kind: "image" | "video"
}

interface ImageLightboxProps {
  /** The media to show full-screen, or null when closed. */
  media: LightboxMedia | null
  onClose: () => void
}

const WHEEL_STEP = 0.0025 // scale delta per wheel px
const DOUBLE_TAP = 2.5 // scale a double-click/tap jumps to

/** Full-screen dimmed overlay showing one image (zoom/pan, t164) or a video (native controls, t165),
 *  with a smooth open/close animation and a download affordance. Rendered inline (position:fixed
 *  escapes the flow); a null media animates the overlay out. Theme-aware via the shared tokens. */
export function ImageLightbox({ media, onClose }: ImageLightboxProps) {
  return (
    <AnimatePresence>
      {media && <LightboxSurface media={media} onClose={onClose} />}
    </AnimatePresence>
  )
}

function LightboxSurface({ media, onClose }: { media: LightboxMedia; onClose: () => void }) {
  const reduce = useReducedMotion()
  const [zoom, setZoom] = useState<ZoomState>(IDENTITY)
  const stageRef = useRef<HTMLDivElement>(null)
  // Live pointers on the stage, keyed by pointerId — drives single-finger pan + two-finger pinch.
  const pointers = useRef(new Map<number, Point>())
  // The two pointer positions at the previous pinch sample (container-relative), for applyPinch.
  const pinchPrev = useRef<[Point, Point] | null>(null)
  // Whether the current single-pointer gesture has moved (a drag) — suppresses the close-on-release.
  const dragged = useRef(false)
  const isVideo = media.kind === "video"

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  const viewport = useCallback((): ViewSize => {
    const r = stageRef.current?.getBoundingClientRect()
    return { w: r?.width ?? window.innerWidth, h: r?.height ?? window.innerHeight }
  }, [])

  const localPoint = useCallback((e: { clientX: number; clientY: number }): Point => {
    const r = stageRef.current?.getBoundingClientRect()
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) }
  }, [])

  // Wheel zoom rides a NON-PASSIVE native listener (t170): React root-attaches `wheel` passively,
  // so a React onWheel's preventDefault silently fails and the page behind the overlay scrolls
  // while zooming. Image stages only — a video stage has no wheel behavior.
  const isVideoRef = useRef(isVideo)
  isVideoRef.current = isVideo
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (isVideoRef.current) return
      e.preventDefault()
      setZoom((z) =>
        zoomAround(z, localPoint(e), z.scale * (1 - e.deltaY * WHEEL_STEP), viewport()),
      )
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [localPoint, viewport])

  const onDoubleClick = (e: React.MouseEvent) => {
    setZoom((z) => zoomAround(z, localPoint(e), isZoomed(z) ? 1 : DOUBLE_TAP, viewport()))
  }

  const onPointerDown = (e: ReactPointerEvent) => {
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    pointers.current.set(e.pointerId, localPoint(e))
    dragged.current = false
    pinchPrev.current = null
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    const prev = pointers.current.get(e.pointerId)!
    const cur = localPoint(e)
    pointers.current.set(e.pointerId, cur)

    if (pointers.current.size >= 2) {
      const pair = [...pointers.current.values()].slice(0, 2) as [Point, Point]
      if (pinchPrev.current) setZoom((z) => applyPinch(z, pinchPrev.current!, pair, viewport()))
      pinchPrev.current = pair
      dragged.current = true
      return
    }

    const dx = cur.x - prev.x
    const dy = cur.y - prev.y
    if (Math.abs(dx) + Math.abs(dy) > 1) dragged.current = true
    setZoom((z) => panBy(z, dx, dy, viewport()))
  }

  const endPointer = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinchPrev.current = null
  }

  // A click that didn't pan and isn't zoomed dismisses (whole stage is the target).
  const onStageClick = () => {
    if (!dragged.current && !isZoomed(zoom)) onClose()
  }

  const cardAnim = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, scale: 0.92 },
        animate: { opacity: 1, scale: 1 },
        exit: { opacity: 0, scale: 0.96 },
      }

  // Image stages get the pan/zoom pointer handlers; a video stage leaves pointers to the native
  // controls and only closes on a backdrop click. (Wheel zoom is the native listener above.)
  const stageHandlers = isVideo
    ? { onClick: onStageClick }
    : {
        onClick: onStageClick,
        onDoubleClick,
        onPointerCancel: endPointer,
        onPointerDown,
        onPointerMove,
        onPointerUp: endPointer,
      }

  return (
    <motion.div
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      exit={{ opacity: 0 }}
      initial={{ opacity: 0 }}
      transition={{ duration: reduce ? 0.1 : 0.16 }}
    >
      <div className="absolute top-3 right-3 z-10 flex gap-2">
        <a
          aria-label="Download"
          className="flex size-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
          download={isVideo ? "teams-video" : "teams-image"}
          href={media.src}
          rel="noopener noreferrer"
        >
          <HugeiconsIcon className="size-5" icon={Download04Icon} />
        </a>
        <button
          aria-label="Close"
          className="flex size-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
          onClick={onClose}
          type="button"
        >
          <HugeiconsIcon className="size-5" icon={Cancel01Icon} />
        </button>
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: standard lightbox stage (pan/zoom/close). */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes (the keydown listener above). */}
      <div
        className="flex size-full touch-none select-none items-center justify-center overflow-hidden"
        ref={stageRef}
        {...stageHandlers}
      >
        {/* Outer card owns the open/close scale+fade; inner media holds its own transform/controls,
            so the two never fight over `transform`. */}
        <motion.div
          className="flex max-h-full max-w-full items-center justify-center"
          transition={{ duration: reduce ? 0.1 : 0.18, ease: "easeOut" }}
          {...cardAnim}
        >
          {isVideo ? (
            // biome-ignore lint/a11y/useMediaCaption: user-authored chat clip, no caption track available.
            <video
              autoPlay
              className="max-h-full max-w-full rounded-md"
              controls
              onClick={(e) => e.stopPropagation()}
              src={media.src}
            />
          ) : (
            <img
              alt=""
              className="max-h-full max-w-full rounded-md object-contain"
              draggable={false}
              src={media.src}
              style={{
                transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
                transformOrigin: "0 0",
                cursor: isZoomed(zoom) ? "grab" : "zoom-in",
              }}
            />
          )}
        </motion.div>
      </div>
    </motion.div>
  )
}
