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
import { fetchMediaCaption } from "../lib/chat-client"
import { chatShell } from "../lib/chat-shell"
import {
  applyPinch,
  clickZoomScale,
  IDENTITY,
  isZoomed,
  type Point,
  panBy,
  type ViewSize,
  wheelIntent,
  type ZoomState,
  zoomAround,
} from "../lib/lightbox-zoom"

/** What the lightbox is showing. `kind` picks the surface: a zoomable image or a native video
 *  player. Downloads use `src` directly (same-origin proxy → forced save). */
export interface LightboxMedia {
  src: string
  kind: "image" | "video"
  /** Where the image lives — lets the lightbox show its transcription (PSN-104). Omit to hide it. */
  convId?: string
  msgId?: string
}

interface ImageLightboxProps {
  /** The media to show full-screen, or null when closed. */
  media: LightboxMedia | null
  onClose: () => void
}

const WHEEL_STEP = 0.0025 // scale delta per wheel px
const PAN_SCALE = 1 // px per wheel px (plain scroll pans 1:1)

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
  const isElectron = !!chatShell()
  const reduce = useReducedMotion()
  const [zoom, setZoom] = useState<ZoomState>(IDENTITY)
  const stageRef = useRef<HTMLDivElement>(null)
  // Live pointers on the stage, keyed by pointerId — drives single-finger pan + two-finger pinch.
  const pointers = useRef(new Map<number, Point>())
  // The two pointer positions at the previous pinch sample (container-relative), for applyPinch.
  const pinchPrev = useRef<[Point, Point] | null>(null)
  // Whether the current single-pointer gesture has moved (a drag) — suppresses click actions.
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

  // Wheel: plain scroll = pan; Ctrl+scroll or trackpad pinch (ctrlKey) = zoom.
  // Rides a NON-PASSIVE native listener: React root-attaches `wheel` passively, so a React
  // onWheel's preventDefault silently fails and the page behind the overlay scrolls.
  const isVideoRef = useRef(isVideo)
  isVideoRef.current = isVideo
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (isVideoRef.current) return
      e.preventDefault()
      if (wheelIntent(e.ctrlKey) === "zoom") {
        setZoom((z) =>
          zoomAround(z, localPoint(e), z.scale * (1 - e.deltaY * WHEEL_STEP), viewport()),
        )
      } else {
        // Plain scroll (no ctrl) = pan. Pan even at fit so the user can "feel" the edge.
        setZoom((z) =>
          panBy(isZoomed(z) ? z : z, -e.deltaX * PAN_SCALE, -e.deltaY * PAN_SCALE, viewport()),
        )
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [localPoint, viewport])

  // Double-click = reset to fit.
  const onDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setZoom(IDENTITY)
  }

  const onPointerDown = (e: ReactPointerEvent) => {
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    pointers.current.set(e.pointerId, localPoint(e))
    dragged.current = false
    pinchPrev.current = null
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    // biome-ignore lint/style/noNonNullAssertion: guarded by has() above
    const prev = pointers.current.get(e.pointerId)!
    const cur = localPoint(e)
    pointers.current.set(e.pointerId, cur)

    if (pointers.current.size >= 2) {
      const pair = [...pointers.current.values()].slice(0, 2) as [Point, Point]
      // biome-ignore lint/style/noNonNullAssertion: only enters this branch when pinchPrev is set
      if (pinchPrev.current) setZoom((z) => applyPinch(z, pinchPrev.current!, pair, viewport()))
      pinchPrev.current = pair
      dragged.current = true
      return
    }

    const dx = cur.x - prev.x
    const dy = cur.y - prev.y
    if (Math.abs(dx) + Math.abs(dy) > 1) dragged.current = true
    if (isZoomed(zoomRef.current)) {
      setZoom((z) => panBy(z, dx, dy, viewport()))
    }
  }

  const endPointer = (e: ReactPointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinchPrev.current = null
  }

  // Single click ON THE IMAGE (not a drag): zoom in at the pointer position.
  const onImageClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (dragged.current) return
    setZoom((z) => zoomAround(z, localPoint(e), clickZoomScale(z), viewport()))
  }

  // Click on the BACKDROP (the stage area outside the image) closes.
  const onStageClick = () => {
    if (!dragged.current) onClose()
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
        onPointerCancel: endPointer,
        onPointerDown,
        onPointerMove,
        onPointerUp: endPointer,
      }

  return (
    <motion.div
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4"
      exit={{ opacity: 0 }}
      initial={{ opacity: 0 }}
      transition={{ duration: reduce ? 0.1 : 0.16 }}
    >
      <div
        className="absolute right-3 z-10 flex gap-2"
        style={
          {
            top: isElectron ? "60px" : "12px",
            WebkitAppRegion: "no-drag",
          } as React.CSSProperties
        }
      >
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
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          type="button"
        >
          <HugeiconsIcon className="size-5" icon={Cancel01Icon} />
        </button>
      </div>
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
            // biome-ignore lint/a11y/noStaticElementInteractions: image click zooms (lightbox gesture).
            // biome-ignore lint/a11y/useKeyWithClickEvents: Esc/keyboard handled by stage keydown listener.
            <img
              alt=""
              className="max-h-full max-w-full rounded-md object-contain"
              draggable={false}
              onClick={onImageClick}
              onDoubleClick={onDoubleClick}
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
      {!isVideo && media.convId && media.msgId && (
        <CaptionPanel convId={media.convId} msgId={media.msgId} src={media.src} />
      )}
    </motion.div>
  )
}

/** The image's transcription, under the picture. It is the same text the assistant reads, so seeing
 *  it here is also how you tell whether the assistant can answer about this screenshot. Long
 *  transcriptions (a dense dashboard) collapse behind show-more and scroll rather than covering the
 *  image. */
function CaptionPanel({ convId, msgId, src }: { convId: string; msgId: string; src: string }) {
  const [state, setState] = useState<{ status: string; caption: string | null }>({
    status: "pending",
    caption: null,
  })
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const ac = new AbortController()
    setState({ status: "pending", caption: null })
    setOpen(false)
    fetchMediaCaption(convId, msgId, src, ac.signal)
      .then(setState)
      .catch(() => {
        if (!ac.signal.aborted) setState({ status: "failed", caption: null })
      })
    return () => ac.abort()
  }, [convId, msgId, src])

  if (state.status === "unsupported") return null
  const long = (state.caption?.length ?? 0) > 220

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: swallows clicks so reading text can't close the lightbox.
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc still closes via the stage listener.
    <div
      className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/85 to-transparent px-4 pt-8 pb-[max(1rem,env(safe-area-inset-bottom))]"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mx-auto max-w-3xl text-white/85 text-xs">
        {/* Labelled, or a wall of transcribed text under the picture reads like a rendering bug. */}
        <div className="mb-1 font-medium text-[10px] text-white/45 uppercase tracking-wide">
          Transcription
        </div>
        {state.status === "pending" && (
          <span className="animate-pulse text-white/60">Reading the image…</span>
        )}
        {state.status === "failed" && <span className="text-white/50">No transcription.</span>}
        {state.caption && (
          <>
            <p
              className={`whitespace-pre-wrap ${open ? "max-h-[40vh] overflow-y-auto" : "line-clamp-3"}`}
            >
              {state.caption}
            </p>
            {long && (
              <button
                className="mt-1 text-white/60 underline-offset-2 hover:underline"
                onClick={() => setOpen((v) => !v)}
                type="button"
              >
                {open ? "Show less" : "Show more"}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
