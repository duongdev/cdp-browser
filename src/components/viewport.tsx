import { useCallback, useEffect, useRef } from "react"
import type { SwitchEffect } from "@/components/settings-dialog"
import { type Event as AdaptiveEvent, type Bounds, initial, reduce } from "@/lib/adaptive-viewport"
import { isOsReservedKey } from "@/lib/key-routing"
import type { RemotePage, ScreencastMetadata } from "@/lib/remote-page"
import { letterbox, toRemoteCoords } from "@/lib/viewport-transform"

/** During a tab-switch settle, how long screencast frames must go quiet before we treat
 *  the reflow as finished and reveal the tab. Adapts the freeze to connection speed and
 *  page complexity (a heavy page like Outlook keeps emitting frames until it's done). */
const FRAMES_QUIET_MS = 200
/** Safety cap on the tab-switch freeze, in case frames never go quiet (animated page). */
const SETTLE_CAP_MS = 1500
/** Blur applied to the frozen frame during a tab-switch settle; eased back to 0 on
 *  reveal so the swap reads as a focus pull instead of a hard snap. */
const SWITCH_BLUR_PX = 8

/** The CSS `filter` for a switch effect: `active` during the freeze, `rest` once revealed.
 *  Both filters name every property so the transition always interpolates (never jumps). */
function effectFilters(effect: SwitchEffect): { active: string; rest: string } {
  const blur = effect === "blur" || effect === "blur-grayscale"
  const gray = effect === "grayscale" || effect === "blur-grayscale"
  return {
    active: `blur(${blur ? SWITCH_BLUR_PX : 0}px) grayscale(${gray ? 1 : 0})`,
    rest: "blur(0px) grayscale(0)",
  }
}

interface ViewportProps {
  page: RemotePage
  onFpsUpdate: (fps: string) => void
  onResolutionUpdate: (res: string) => void
  /** When on, the remote viewport is resized to fill the canvas (no letterbox). */
  adaptiveEnabled: boolean
  /** When on, a host-resize back-off auto-recovers (re-imposes the client size on the
   *  next viewport interaction). When off, a host resize disables adaptive mode entirely
   *  (the previous behavior) — see onAdaptivePaused. */
  forceOnClient: boolean
  /** Visual effect easing a tab switch in/out (works in both modes). */
  switchEffect: SwitchEffect
  /** Bumped on each successful (re)connect so the override re-applies on a fresh socket. */
  connectEpoch: number
  /** Bumped the instant a tab switch starts, so the freeze/effect begins immediately. */
  switchSignal: number
  /** Reports the device-metrics size currently imposed (null when none) for the readout. */
  onEmulatedSizeChange: (size: { w: number; h: number } | null) => void
  /** A host resize backed adaptive off and auto-recover is disabled: tell App to turn
   *  the setting off so the toggle reflects it and re-arming is a normal off→on. */
  onAdaptivePaused: () => void
}

export function Viewport({
  page,
  onFpsUpdate,
  onResolutionUpdate,
  adaptiveEnabled,
  forceOnClient,
  switchEffect,
  connectEpoch,
  switchSignal,
  onEmulatedSizeChange,
  onAdaptivePaused,
}: ViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef(new Image())
  const imgSizeRef = useRef({ width: 0, height: 0 })
  // Latest frame metadata: the remote viewport's DIP geometry, used to map input back
  // into the remote page when the screencast frame is downscaled from it.
  const metaRef = useRef<ScreencastMetadata | null>(null)
  const frameCountRef = useRef(0)
  const lastFpsTimeRef = useRef(Date.now())

  // Adaptive Viewport controller. The reducer (pure, unit-tested) decides what to do;
  // this component just executes the emitted effects as CDP sends and runs the
  // host-resize poll. `pollable` records whether the Browser domain answered — if not,
  // path A (override) still works but path B (host-resize back-off) stays disabled.
  const adaptiveRef = useRef(initial)
  const adaptiveEnabledRef = useRef(adaptiveEnabled)
  const forceOnClientRef = useRef(forceOnClient)
  const switchEffectRef = useRef(switchEffect)
  const onEmulatedSizeChangeRef = useRef(onEmulatedSizeChange)
  onEmulatedSizeChangeRef.current = onEmulatedSizeChange
  const pollableRef = useRef(false)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  // While true (during a tab-switch transition), incoming frames are held back: in
  // adaptive mode this hides the reflow jiggle; with blur on it backs the focus pull.
  const settlingRef = useRef(false)
  const settleCapRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Fires once a switched-to tab's frames go quiet (reflow finished), to reveal it.
  // Reset on every frame received during the settle.
  const quietTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  // False between a switch starting and its new connection landing — frames before then
  // are stale (old tab) and must not trigger a reveal.
  const connectedSinceSwitchRef = useRef(true)

  // Letterbox the current frame into the canvas at the container's live size.
  // Used both on new frames and on container resize (e.g. sidebar toggle), so
  // the viewport reflows without waiting for the next remote frame.
  const paint = useCallback(() => {
    const canvas = canvasRef.current
    const vp = containerRef.current
    const img = imgRef.current
    if (!canvas || !vp || !img.width) return
    // biome-ignore lint/style/noNonNullAssertion: 2d context is always available on an HTMLCanvasElement
    const ctx = canvas.getContext("2d")!

    canvas.width = vp.clientWidth * window.devicePixelRatio
    canvas.height = vp.clientHeight * window.devicePixelRatio
    canvas.style.width = `${vp.clientWidth}px`
    canvas.style.height = `${vp.clientHeight}px`

    const { scale, dx, dy } = letterbox(
      { w: img.width, h: img.height },
      { w: canvas.width, h: canvas.height },
    )

    ctx.fillStyle = "#000"
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, dx, dy, img.width * scale, img.height * scale)
  }, [])

  // Re-issue the screencast at the current canvas size. Independent of adaptive mode:
  // off, it caps a letterboxed native frame; on, it matches the just-applied override.
  const reissueScreencast = useCallback(() => {
    const vp = containerRef.current
    if (!vp) return
    window.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 80,
      maxWidth: Math.floor(vp.clientWidth * window.devicePixelRatio),
      maxHeight: Math.floor(vp.clientHeight * window.devicePixelRatio),
    })
  }, [])

  // Run the reducer and flush its effects to the active CDP socket.
  const dispatchAdaptive = useCallback((event: AdaptiveEvent) => {
    const { state, effects } = reduce(adaptiveRef.current, event)
    adaptiveRef.current = state
    for (const eff of effects) {
      if (eff.type === "applyOverride") {
        window.cdp.send("Emulation.setDeviceMetricsOverride", eff.metrics)
        onEmulatedSizeChangeRef.current({ w: eff.metrics.width, h: eff.metrics.height })
      } else {
        window.cdp.send("Emulation.clearDeviceMetricsOverride", {})
        onEmulatedSizeChangeRef.current(null)
      }
    }
    return state
  }, [])

  // The real OS window rect, unaffected by device-metrics emulation. Null means the
  // Browser domain isn't answering (or we're disconnected) — host-resize detection off.
  const getHostBounds = useCallback(async (): Promise<Bounds | null> => {
    const r = await window.cdp.invoke("Browser.getWindowForTarget")
    const b = r?.bounds
    const bounds =
      b && typeof b.width === "number" && typeof b.height === "number"
        ? { width: b.width, height: b.height }
        : null
    // Arm/disarm host-resize polling based on whether the Browser domain answers.
    // Set here (not only in applyAdaptive) so the reconnect path, which queries bounds
    // after the socket is up, also flips pollable on — applyAdaptive often runs while
    // still disconnected ("not connected") and would otherwise leave it stuck false.
    pollableRef.current = bounds !== null
    return bounds
  }, [])

  const stopPoll = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = undefined
    }
  }, [])

  const startPoll = useCallback(() => {
    if (pollTimerRef.current || !pollableRef.current) return
    pollTimerRef.current = setInterval(async () => {
      const s = adaptiveRef.current
      if (!s.enabled || s.dormant) return stopPoll()
      const bounds = await getHostBounds()
      if (!bounds) return
      // Host-resize drift: the reducer goes dormant and clears the override. When
      // "auto-recover" (forceOnClient) is on, the setting stays on and re-arms on the
      // next viewport interaction (see maybeRearm). When off, fall back to the previous
      // behavior — turn the setting off so the toggle reflects it (manual re-enable).
      if (dispatchAdaptive({ type: "poll", bounds }).dormant) {
        stopPoll()
        if (!forceOnClientRef.current) onAdaptivePaused()
      }
    }, 1500)
  }, [dispatchAdaptive, getHostBounds, stopPoll, onAdaptivePaused])

  // Apply/refresh the override at the live canvas size and re-baseline host bounds.
  const applyAdaptive = useCallback(async () => {
    const vp = containerRef.current
    if (!vp) return
    const bounds = await getHostBounds()
    dispatchAdaptive({
      type: "resize",
      canvas: { w: vp.clientWidth, h: vp.clientHeight },
      bounds: bounds ?? { width: 0, height: 0 },
    })
  }, [dispatchAdaptive, getHostBounds])

  // Interacting with the viewport after a graceful back-off means the user is back on
  // the CDP browser (interaction implies window focus) — re-impose the client size.
  const maybeRearm = useCallback(() => {
    const s = adaptiveRef.current
    if (!s.enabled || !s.dormant) return
    const vp = containerRef.current
    if (!vp) return
    getHostBounds().then((bounds) => {
      dispatchAdaptive({
        type: "rearm",
        canvas: { w: vp.clientWidth, h: vp.clientHeight },
        bounds: bounds ?? { width: 0, height: 0 },
      })
      reissueScreencast()
      startPoll()
    })
  }, [getHostBounds, dispatchAdaptive, reissueScreencast, startPoll])

  // End the tab-switch freeze: paint the latest (now-settled) frame and ease the effect
  // back out — the new tab pulls into focus.
  const revealSettled = useCallback(() => {
    if (!settlingRef.current) return
    settlingRef.current = false
    clearTimeout(settleCapRef.current)
    clearTimeout(quietTimerRef.current)
    paint()
    if (canvasRef.current) {
      canvasRef.current.style.filter = effectFilters(switchEffectRef.current).rest
    }
  }, [paint])

  // Draw each frame. While settling after a tab switch, frames are held back until the
  // new tab is ready: adaptive waits for the reflow's frames to go quiet; otherwise the
  // first frame of the new connection reveals. Frames before the new connection lands are
  // stale (old tab) and ignored. Outside a settle, frames paint immediately.
  useEffect(() => {
    const img = imgRef.current

    img.onload = () => {
      imgSizeRef.current = { width: img.width, height: img.height }

      if (settlingRef.current) {
        if (!connectedSinceSwitchRef.current) return // stale old-tab frame
        if (adaptiveEnabledRef.current) {
          // Reflowing: hold the last frame, restart the quiet countdown.
          clearTimeout(quietTimerRef.current)
          quietTimerRef.current = setTimeout(revealSettled, FRAMES_QUIET_MS)
        } else {
          // No reflow — the first frame of the new connection is good.
          revealSettled()
        }
        return
      }

      paint()

      onResolutionUpdate(`${img.width}x${img.height}`)
      frameCountRef.current++
      const now = Date.now()
      if (now - lastFpsTimeRef.current >= 1000) {
        onFpsUpdate(`${frameCountRef.current} FPS`)
        frameCountRef.current = 0
        lastFpsTimeRef.current = now
      }
    }

    return page.onFrame((frame) => {
      metaRef.current = frame.metadata ?? null
      img.src = `data:image/jpeg;base64,${frame.data}`
    })
  }, [page, paint, onFpsUpdate, onResolutionUpdate, revealSettled])

  // Start at an explicit resting filter (not `none`) so the first switch transition
  // interpolates instead of jumping.
  useEffect(() => {
    if (canvasRef.current) canvasRef.current.style.filter = "blur(0px) grayscale(0)"
  }, [])

  // The Viewport owns the canvas geometry, so it supplies the coordinate resolver
  // the Remote Page uses to hit-test Input Forwarding.
  useEffect(() => {
    page.setCoordResolver((clientX, clientY) => {
      const canvas = canvasRef.current
      if (!canvas) return { x: 0, y: 0 }
      const { width: w, height: h } = imgSizeRef.current
      const m = metaRef.current
      return toRemoteCoords(
        { x: clientX, y: clientY },
        canvas.getBoundingClientRect(),
        window.devicePixelRatio,
        { w, h },
        m ? { w: m.deviceWidth, h: m.deviceHeight } : undefined,
        m?.offsetTop ?? 0,
      )
    })
  }, [page])

  // Any container size change (window resize OR sidebar toggle) repaints the current
  // frame immediately, then (debounced) refreshes the adaptive override and re-issues
  // the screencast at the new size so the remote re-renders at the correct resolution.
  useEffect(() => {
    const vp = containerRef.current
    if (!vp) return
    let timer: ReturnType<typeof setTimeout>
    const observer = new ResizeObserver(() => {
      paint()
      clearTimeout(timer)
      timer = setTimeout(async () => {
        if (adaptiveEnabledRef.current) {
          await applyAdaptive()
          startPoll()
        }
        reissueScreencast()
      }, 150)
    })
    observer.observe(vp)
    return () => {
      observer.disconnect()
      clearTimeout(timer)
    }
  }, [paint, applyAdaptive, startPoll, reissueScreencast])

  // Toggling the setting arms or tears down adaptive mode immediately on the live tab.
  useEffect(() => {
    adaptiveEnabledRef.current = adaptiveEnabled
    if (adaptiveEnabled) {
      dispatchAdaptive({ type: "enable" })
      applyAdaptive().then(() => {
        reissueScreencast()
        startPoll()
      })
    } else {
      dispatchAdaptive({ type: "disable" }) // emits clearDeviceMetricsOverride
      stopPoll()
      // Drop any in-flight settle so the view never stays frozen/blurred when off.
      settlingRef.current = false
      clearTimeout(settleCapRef.current)
      clearTimeout(quietTimerRef.current)
      if (canvasRef.current) canvasRef.current.style.filter = "blur(0px) grayscale(0)"
      reissueScreencast() // override gone — frame returns to the host's native size
    }
    return () => stopPoll()
  }, [adaptiveEnabled, dispatchAdaptive, applyAdaptive, startPoll, stopPoll, reissueScreencast])

  // Mirror the auto-recover preference for use inside the poll callback.
  useEffect(() => {
    forceOnClientRef.current = forceOnClient
  }, [forceOnClient])

  // A tab switch reconnects on a fresh socket. The main process re-applies the cached
  // override before the first frame (so no jiggle), so here we only re-anchor the
  // host-resize baseline and resume the poll — never re-send the override ourselves.
  // Skipped while dormant: a host takeover must not be silently re-armed.
  useEffect(() => {
    switchEffectRef.current = switchEffect
  }, [switchEffect])

  // biome-ignore lint/correctness/useExhaustiveDependencies: connectEpoch is a trigger signal — bumped on reconnect to re-run this effect; it's not read in the body
  useEffect(() => {
    // The new connection has landed: frames from here on are the new tab.
    if (settlingRef.current) connectedSinceSwitchRef.current = true
    if (!adaptiveEnabledRef.current || adaptiveRef.current.dormant) return
    getHostBounds().then((bounds) => {
      if (bounds) dispatchAdaptive({ type: "rebaseline", bounds })
      startPoll()
    })
  }, [connectEpoch, getHostBounds, dispatchAdaptive, startPoll])

  // Freeze the display the instant a tab switch starts (driven by `switchSignal`, before
  // the connect round-trip, so the blur is immediate). Freeze when adaptive (to hide the
  // reflow jiggle) or when blur is on (to back the focus pull). The held frame is revealed
  // once the new tab is ready — see the frame loop — with this cap as a backstop.
  useEffect(() => {
    if (switchSignal === 0) return
    const effect = switchEffectRef.current
    if (!adaptiveEnabledRef.current && effect === "none") return
    settlingRef.current = true
    connectedSinceSwitchRef.current = false
    if (effect !== "none" && canvasRef.current) {
      canvasRef.current.style.filter = effectFilters(effect).active
    }
    clearTimeout(settleCapRef.current)
    settleCapRef.current = setTimeout(revealSettled, SETTLE_CAP_MS)
    return () => clearTimeout(settleCapRef.current)
  }, [switchSignal, revealSettled])

  // A disconnect only stops the poll; the main process clears the override on the
  // outgoing socket, and the baseline stays valid (the host window is unchanged).
  useEffect(() => {
    return page.on((e) => {
      if (e.type === "disconnected") stopPoll()
    })
  }, [page, stopPoll])

  // Keyboard forwarding (canvas-level events that aren't app hotkeys go to the page)
  useEffect(() => {
    const isField = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      return tag === "INPUT" || tag === "TEXTAREA"
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isField(e) || isOsReservedKey(e)) return
      e.preventDefault()
      maybeRearm()
      page.forwardInput({ kind: "key", phase: "down", event: e })
    }
    const handleKeyUp = (e: KeyboardEvent) => {
      if (isField(e) || isOsReservedKey(e)) return
      page.forwardInput({ kind: "key", phase: "up", event: e })
    }
    document.addEventListener("keydown", handleKeyDown)
    document.addEventListener("keyup", handleKeyUp)
    return () => {
      document.removeEventListener("keydown", handleKeyDown)
      document.removeEventListener("keyup", handleKeyUp)
    }
  }, [page, maybeRearm])

  return (
    <div className="flex-1 relative bg-black overflow-hidden" ref={containerRef}>
      <canvas
        className="w-full h-full block cursor-default transition-[filter] duration-200 ease-out"
        onContextMenu={(e) => {
          e.preventDefault() // prevent Electron's native context menu
        }}
        onMouseDown={(e) => {
          e.preventDefault() // stop native focus/drag stealing the gesture
          maybeRearm()
          // e.detail carries the consecutive-click count: 2 = word, 3 = paragraph
          page.forwardInput({
            kind: "mouse",
            phase: "pressed",
            event: e,
            clickCount: e.detail || 1,
          })
        }}
        onMouseMove={(e) => page.forwardInput({ kind: "mouse", phase: "moved", event: e })}
        onMouseUp={(e) =>
          page.forwardInput({
            kind: "mouse",
            phase: "released",
            event: e,
            clickCount: e.detail || 1,
          })
        }
        onWheel={(e) => {
          maybeRearm()
          page.forwardInput({ kind: "wheel", event: e })
          e.preventDefault()
        }}
        ref={canvasRef}
      />
    </div>
  )
}
