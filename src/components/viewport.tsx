import { useCallback, useEffect, useRef, useState } from "react"
import type { SwitchEffect } from "@/components/settings-dialog"
import { useAnyPointerFine } from "@/hooks/use-pointer-coarse"
import { type Event as AdaptiveEvent, type Bounds, initial, reduce } from "@/lib/adaptive-viewport"
import {
  type EchoCursor,
  type EchoEvent,
  type EchoState,
  initial as echoInitial,
  reduce as echoReduce,
  view as echoView,
  PRESS_FLASH_MS,
} from "@/lib/echo-cursor"
import { isOsReservedKey } from "@/lib/key-routing"
import { perfFrame, perfMark } from "@/lib/perf-mark"
import type { RemotePage } from "@/lib/remote-page"
import { createTouchGesture, type GestureEvent, LONGPRESS_MS } from "@/lib/touch-gesture"
import { drawFrame, type Size, toRemoteCoords } from "@/lib/viewport-transform"
import {
  parseMode,
  shouldShowVirtualPointer,
  subscribeVirtualPointerMode,
  VIRTUAL_POINTER_MODE_KEY,
  type VirtualPointerMode,
} from "@/lib/virtual-pointer"

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

/** The frame-view snapshot both the draw path and the Input Forwarding hit-test read.
 *  Captured at paint time so draw and input always reason about the same frame. */
interface FrameView {
  /** Image px of the painted Screencast Frame. */
  frame: Size
  /** Remote layout viewport DIP size when the frame is downscaled (metadata
   *  `deviceWidth`/`deviceHeight`); omitted means a 1:1 (non-downscaled) frame. */
  device?: Size
  /** Metadata vertical DIP offset of the captured area (0 on desktop). */
  offsetTop: number
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
  // The single frame-view snapshot, captured the moment a frame is painted: the painted
  // frame's image px, plus its remote DIP geometry (device size + vertical offset) when
  // downscaled. Both the draw path (re-letterbox on resize) and the Input Forwarding
  // hit-test read it, so the two can never reason about different frame dimensions.
  const frameViewRef = useRef<FrameView>({ frame: { w: 0, h: 0 }, offsetTop: 0 })
  const frameCountRef = useRef(0)
  const lastFpsTimeRef = useRef(Date.now())
  // Ack-after-paint (t056): the session id of the frame currently flowing through the
  // data-URL paint path (`img.onload` runs a tick after `img.src` is set, so it can't read
  // the per-frame closure). The web transport acks the painted frame so the server gates
  // the next one to a single in-flight frame. Electron's bridge has no `ackPaintedFrame` —
  // the `?.` no-ops there (the renderer's remote-page already auto-acks on handle).
  const ackSessionRef = useRef<number | null>(null)
  const ackPainted = useCallback((sessionId: number | null) => {
    if (sessionId !== null) window.cdp.ackPaintedFrame?.(sessionId)
  }, [])

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

  // The finger touch layer (ADR-0009): a fresh gesture classifier per touch `pointerdown`,
  // and a timer that drives the classifier's long-press deadline poll (kept out of the
  // pure module). Null between touches. Pointer ids guard against a second finger leaking
  // into the single-finger gesture.
  const gestureRef = useRef<ReturnType<typeof createTouchGesture> | null>(null)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const touchPointerIdRef = useRef<number | null>(null)

  // Echo cursor (t052): a local overlay drawing the pointer/press the user just expressed,
  // ahead of the remote frame that confirms it a beat later. The pure model owns all
  // show/hide/expiry decisions; this component only feeds it the same client coordinates
  // it hands to `forwardInput` and renders what `echoView` returns. Whether the overlay is
  // *visible at all* is gated by the virtual-pointer mode below (off | on | auto).
  const echoStateRef = useRef<EchoState>(echoInitial)
  const [echo, setEcho] = useState<EchoCursor>({ pos: null, press: null })
  const pressExpiryRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Virtual pointer visibility (off | on | auto). The mode persists in server ui-state
  // (survives a PWA refresh); read it once on mount and follow live changes from the
  // settings toggle via the CustomEvent. `auto` hides the overlay whenever any fine pointer
  // exists (trackpad/mouse attached) and shows it on bare touch. Default `auto` until the
  // ui-state read lands. See virtual-pointer.ts.
  const [vpMode, setVpMode] = useState<VirtualPointerMode>("auto")
  const anyPointerFine = useAnyPointerFine()
  const showVirtualPointer = shouldShowVirtualPointer(vpMode, anyPointerFine)
  useEffect(() => {
    window.cdp
      ?.getUiState?.()
      .then((ui) => setVpMode(parseMode(ui?.[VIRTUAL_POINTER_MODE_KEY])))
      .catch(() => {})
    return subscribeVirtualPointerMode(setVpMode)
  }, [])

  // Fold one echo event and publish the derived overlay. Coords are container-relative CSS
  // px (the same `clientX`/`clientY` the input path uses, offset by the live container rect)
  // so the dot sits exactly under the pointer with no second mapping to drift from.
  const dispatchEcho = useCallback((event: EchoEvent) => {
    const now = performance.now()
    echoStateRef.current = echoReduce(echoStateRef.current, event, now)
    setEcho(echoView(echoStateRef.current, now))
    // A press needs one UI timer to clear its flash if no further event arrives; the model
    // already reaps expired presses on any event, so this only drops the lingering visual.
    if (event.type === "press") {
      clearTimeout(pressExpiryRef.current)
      pressExpiryRef.current = setTimeout(() => {
        setEcho(echoView(echoStateRef.current, performance.now()))
      }, PRESS_FLASH_MS)
    }
  }, [])

  // Map an event's client point to the container-relative CSS px the overlay renders at.
  const echoPoint = useCallback((clientX: number, clientY: number) => {
    const vp = containerRef.current
    if (!vp) return { x: clientX, y: clientY }
    const rect = vp.getBoundingClientRect()
    return { x: clientX - rect.left, y: clientY - rect.top }
  }, [])

  // A frame just painted: arm the echo gate (only on the false→true edge, so the per-frame
  // hot path doesn't re-render the overlay every frame).
  const noteEchoFrame = useCallback(() => {
    if (!echoStateRef.current.hasFrame) dispatchEcho({ type: "frame-state", hasFrame: true })
  }, [dispatchEcho])

  // Paint a frame source (decoded Image or ImageBitmap) into the canvas at the container's
  // live size. The single Canvas touch — fed by the pure `drawFrame` geometry so both paint
  // paths (and the hit-test) share one source of letterbox/placement truth.
  const paintSource = useCallback((source: CanvasImageSource, frame: Size) => {
    const canvas = canvasRef.current
    const vp = containerRef.current
    if (!canvas || !vp || !frame.w) return
    // biome-ignore lint/style/noNonNullAssertion: 2d context is always available on an HTMLCanvasElement
    const ctx = canvas.getContext("2d")!

    const layout = drawFrame(
      { w: vp.clientWidth * window.devicePixelRatio, h: vp.clientHeight * window.devicePixelRatio },
      frame,
    )
    canvas.width = layout.canvas.w
    canvas.height = layout.canvas.h
    canvas.style.width = `${vp.clientWidth}px`
    canvas.style.height = `${vp.clientHeight}px`

    ctx.fillStyle = "#000"
    ctx.fillRect(layout.fill.left, layout.fill.top, layout.fill.width, layout.fill.height)
    ctx.drawImage(source, layout.dest.x, layout.dest.y, layout.dest.w, layout.dest.h)
  }, [])

  // Re-letterbox the current frame into the canvas at the container's live size, reading
  // the painted frame's size from the snapshot. Used both on new (decoded-Image) frames and
  // on container resize (e.g. sidebar toggle), so the viewport reflows without waiting for
  // the next remote frame.
  const paint = useCallback(() => {
    const img = imgRef.current
    if (!img.width) return
    paintSource(img, { w: img.width, h: img.height })
  }, [paintSource])

  // Re-issue the screencast at the current canvas size. Independent of adaptive mode:
  // off, it caps a letterboxed native frame; on, it matches the just-applied override.
  const reissueScreencast = useCallback(() => {
    const vp = containerRef.current
    if (!vp) return
    // Cap the screencast at 1920×1080 CSS-equivalent regardless of DPR. A 12.9" iPad Pro
    // (1366×1024 @ DPR 2) would otherwise request 2732×2048 JPEGs and saturate any link
    // before the renderer even saw a frame — t019 perf work showed quality, not raw size,
    // is what drives perceived sharpness. 1920×1080 q80 still looks crisp downscaled.
    const dpr = Math.min(window.devicePixelRatio, 2)
    const w = Math.min(Math.floor(vp.clientWidth * dpr), 1920)
    const h = Math.min(Math.floor(vp.clientHeight * dpr), 1080)
    window.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 80,
      maxWidth: w,
      maxHeight: h,
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

  // Translate a classified finger gesture into the existing Input Forwarding intents, so
  // touch reuses the mouse/wheel path and `toRemoteCoords` (no new transport verb). A tap
  // and a long-press are a press/release pair that differ only in the button (left vs
  // right). The synthetic event-like payloads carry no real modifiers (a finger has none).
  const applyGesture = useCallback(
    (ev: GestureEvent) => {
      const mods = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
      if (ev.type === "scroll") {
        page.forwardInput({
          kind: "wheel",
          event: { clientX: ev.x, clientY: ev.y, deltaX: ev.deltaX, deltaY: ev.deltaY, ...mods },
        })
        return
      }
      const button = ev.type === "longpress" ? 2 : 0
      // Flash the optimistic press at the same point we forward — echo and tap share coords.
      dispatchEcho({ type: "press", pos: echoPoint(ev.x, ev.y) })
      const point = { clientX: ev.x, clientY: ev.y, ...mods }
      page.forwardInput({
        kind: "mouse",
        phase: "pressed",
        event: { ...point, button, buttons: button === 2 ? 2 : 1 },
        clickCount: 1,
      })
      page.forwardInput({
        kind: "mouse",
        phase: "released",
        event: { ...point, button, buttons: 0 },
        clickCount: 1,
      })
    },
    [page, dispatchEcho, echoPoint],
  )

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

    let tFrameRecv = 0 // [DEBUG-perf] when onFrame fired
    img.onload = () => {
      // [DEBUG-perf] img.src→onload spans base64-string parse + JPEG decode (data-URL path).
      if (tFrameRecv) perfMark("frameToDecode", performance.now() - tFrameRecv)
      frameViewRef.current = { ...frameViewRef.current, frame: { w: img.width, h: img.height } }

      if (settlingRef.current) {
        // A held/skipped frame is still decisively handled — ack it so the stream keeps
        // flowing (the quiet detector needs frames; a withheld ack would stall it). (t056)
        if (!connectedSinceSwitchRef.current) return // stale old-tab frame (gate ignores its ack)
        ackPainted(ackSessionRef.current)
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

      const tPaint = performance.now() // [DEBUG-perf]
      paint()
      perfMark("paint", performance.now() - tPaint)
      ackPainted(ackSessionRef.current) // one in flight: ack now that this frame is on-screen
      perfFrame()
      noteEchoFrame()

      onResolutionUpdate(`${img.width}x${img.height}`)
      frameCountRef.current++
      const now = Date.now()
      if (now - lastFpsTimeRef.current >= 1000) {
        onFpsUpdate(`${frameCountRef.current} FPS`)
        frameCountRef.current = 0
        lastFpsTimeRef.current = now
      }
    }

    return page.onFrame(async (frame) => {
      tFrameRecv = performance.now() // [DEBUG-perf]
      // The remote DIP geometry half of the snapshot — set here so whichever paint path
      // runs (and the hit-test) reads the same metadata for this frame; the frame's image
      // px half is filled in at paint time by each path.
      const m = frame.metadata
      const device = m ? { w: m.deviceWidth, h: m.deviceHeight } : undefined
      const offsetTop = m?.offsetTop ?? 0
      // Fast path: web build's binary WS delivers a Blob — decode via createImageBitmap,
      // off-main-thread + no data-URL allocation. Falls through to the data-URL path for
      // Electron (IPC carries the base64 string) and for SSE web mode.
      // The frame currently being painted, for the post-paint ack (t056). The data-URL path
      // reads it in `img.onload`; the binary path acks inline below.
      ackSessionRef.current = frame.sessionId
      if (frame.dataBlob) {
        try {
          const bitmap = await createImageBitmap(frame.dataBlob)
          frameViewRef.current = { frame: { w: bitmap.width, h: bitmap.height }, device, offsetTop }
          const tPaint = performance.now() // [DEBUG-perf]
          paintSource(bitmap, { w: bitmap.width, h: bitmap.height })
          perfMark("paint", performance.now() - tPaint)
          ackPainted(frame.sessionId) // one in flight: ack now that this frame is on-screen
          perfMark("frameToDecode", performance.now() - tFrameRecv)
          perfFrame()
          noteEchoFrame()
          onResolutionUpdate(`${bitmap.width}x${bitmap.height}`)
          bitmap.close()
          return
        } catch {
          // Decode failed — fall through to legacy data-URL path with whatever `data` is.
        }
      }
      frameViewRef.current = { ...frameViewRef.current, device, offsetTop }
      img.src = `data:image/jpeg;base64,${frame.data}`
    })
  }, [
    page,
    paint,
    paintSource,
    onFpsUpdate,
    onResolutionUpdate,
    revealSettled,
    noteEchoFrame,
    ackPainted,
  ])

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
      const view = frameViewRef.current
      return toRemoteCoords(
        { x: clientX, y: clientY },
        canvas.getBoundingClientRect(),
        window.devicePixelRatio,
        view.frame,
        view.device,
        view.offsetTop,
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
      if (e.type === "disconnected") {
        stopPoll()
        dispatchEcho({ type: "disconnect" })
      }
    })
  }, [page, stopPoll, dispatchEcho])

  // Drop in-flight timers on unmount so they never fire into a dead page.
  useEffect(
    () => () => {
      clearTimeout(longPressTimerRef.current)
      clearTimeout(pressExpiryRef.current)
    },
    [],
  )

  // Keyboard forwarding (canvas-level events that aren't app hotkeys go to the page)
  useEffect(() => {
    const isField = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      return tag === "INPUT" || tag === "TEXTAREA"
    }
    // Don't leak keys to the remote page when an overlay owns focus — the notification
    // popover / context menu (radix popper), the ⌘K palette + settings sheet (dialog),
    // or the unpin confirm (alertdialog). Their own arrow/Enter/Backspace nav must not
    // double as page input. `defaultPrevented` covers keys an overlay already handled.
    const inOverlay = () =>
      !!document.activeElement?.closest(
        '[data-radix-popper-content-wrapper],[role="dialog"],[role="alertdialog"]',
      )
    const skip = (e: KeyboardEvent) =>
      isField(e) || isOsReservedKey(e) || e.defaultPrevented || inOverlay()
    const handleKeyDown = (e: KeyboardEvent) => {
      if (skip(e)) return
      e.preventDefault()
      maybeRearm()
      page.forwardInput({ kind: "key", phase: "down", event: e })
    }
    const handleKeyUp = (e: KeyboardEvent) => {
      if (skip(e)) return
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
        className="w-full h-full block cursor-default touch-none transition-[filter] duration-200 ease-out"
        onContextMenu={(e) => {
          e.preventDefault() // prevent Electron's native context menu
        }}
        onMouseDown={(e) => {
          e.preventDefault() // stop native focus/drag stealing the gesture
          maybeRearm()
          dispatchEcho({ type: "press", pos: echoPoint(e.clientX, e.clientY) })
          // e.detail carries the consecutive-click count: 2 = word, 3 = paragraph
          page.forwardInput({
            kind: "mouse",
            phase: "pressed",
            event: e,
            clickCount: e.detail || 1,
          })
        }}
        onMouseEnter={(e) => {
          dispatchEcho({ type: "enter" })
          dispatchEcho({ type: "move", pos: echoPoint(e.clientX, e.clientY) })
        }}
        onMouseLeave={() => dispatchEcho({ type: "leave" })}
        onMouseMove={(e) => {
          dispatchEcho({ type: "move", pos: echoPoint(e.clientX, e.clientY) })
          page.forwardInput({ kind: "mouse", phase: "moved", event: e })
        }}
        onMouseUp={(e) =>
          page.forwardInput({
            kind: "mouse",
            phase: "released",
            event: e,
            clickCount: e.detail || 1,
          })
        }
        onPointerCancel={(e) => {
          if (e.pointerType !== "touch" || e.pointerId !== touchPointerIdRef.current) return
          clearTimeout(longPressTimerRef.current)
          gestureRef.current?.cancel()
          gestureRef.current = null
          touchPointerIdRef.current = null
          dispatchEcho({ type: "leave" })
        }}
        onPointerDown={(e) => {
          // Touch only. Mouse/trackpad pointers stay on the onMouse* path untouched.
          if (e.pointerType !== "touch") return
          // Ignore extra fingers — this slice is single-finger (ADR-0009).
          if (touchPointerIdRef.current !== null) return
          // Consume so iPad Safari doesn't synthesize a parallel mouse click from this touch.
          e.preventDefault()
          maybeRearm()
          touchPointerIdRef.current = e.pointerId
          // Show the echo under the finger immediately (it's the only visible pointer there).
          dispatchEcho({ type: "enter" })
          dispatchEcho({ type: "move", pos: echoPoint(e.clientX, e.clientY) })
          const g = createTouchGesture()
          gestureRef.current = g
          g.down({ x: e.clientX, y: e.clientY, t: performance.now() })
          clearTimeout(longPressTimerRef.current)
          longPressTimerRef.current = setTimeout(() => {
            for (const ev of g.poll(performance.now())) applyGesture(ev)
          }, LONGPRESS_MS)
        }}
        onPointerMove={(e) => {
          if (e.pointerType !== "touch" || e.pointerId !== touchPointerIdRef.current) return
          e.preventDefault()
          const g = gestureRef.current
          if (!g) return
          dispatchEcho({ type: "move", pos: echoPoint(e.clientX, e.clientY) })
          const events = g.move({ x: e.clientX, y: e.clientY, t: performance.now() })
          if (events.length) clearTimeout(longPressTimerRef.current) // a drag cancels long-press
          for (const ev of events) applyGesture(ev)
        }}
        onPointerUp={(e) => {
          if (e.pointerType !== "touch" || e.pointerId !== touchPointerIdRef.current) return
          e.preventDefault()
          clearTimeout(longPressTimerRef.current)
          const g = gestureRef.current
          if (g)
            for (const ev of g.up({ x: e.clientX, y: e.clientY, t: performance.now() }))
              applyGesture(ev)
          gestureRef.current = null
          touchPointerIdRef.current = null
          dispatchEcho({ type: "leave" })
        }}
        onWheel={(e) => {
          maybeRearm()
          page.forwardInput({ kind: "wheel", event: e })
          e.preventDefault()
        }}
        ref={canvasRef}
      />
      {showVirtualPointer && <EchoOverlay echo={echo} />}
    </div>
  )
}

/**
 * The echo cursor overlay (t052): a presentation-only sibling above the screencast canvas,
 * rendering the pure model's `pos`/`press` at container-relative CSS px. `pointer-events-none`
 * so it never intercepts input; it sits in normal CSS z-order above the canvas (no native
 * view, no z-order fight). Nothing renders when the model reports inert.
 */
function EchoOverlay({ echo }: { echo: EchoCursor }) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {echo.pos && (
        <span
          className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/70 bg-white/10 shadow-[0_0_2px_rgba(0,0,0,0.6)]"
          style={{ left: echo.pos.x, top: echo.pos.y }}
        />
      )}
      {echo.press && (
        <span
          className="absolute size-6 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full bg-white/40"
          key={echo.press.until}
          style={{ left: echo.press.x, top: echo.press.y }}
        />
      )}
    </div>
  )
}
