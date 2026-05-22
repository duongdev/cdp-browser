import { useCallback, useEffect, useRef } from "react";
import { letterbox, toRemoteCoords } from "@/lib/viewport-transform";
import {
  reduce,
  initial,
  type Event as AdaptiveEvent,
  type Bounds,
} from "@/lib/adaptive-viewport";
import type { RemotePage } from "@/lib/remote-page";

/** During a tab-switch settle, how long screencast frames must go quiet before we treat
 *  the reflow as finished and reveal the tab. Adapts the freeze to connection speed and
 *  page complexity (a heavy page like Outlook keeps emitting frames until it's done). */
const FRAMES_QUIET_MS = 200;
/** Safety cap on the tab-switch freeze, in case frames never go quiet (animated page). */
const SETTLE_CAP_MS = 1500;
/** Blur applied to the frozen frame during a tab-switch settle; eased back to 0 on
 *  reveal so the swap reads as a focus pull instead of a hard snap. */
const SWITCH_BLUR_PX = 8;

interface ViewportProps {
  page: RemotePage;
  onFpsUpdate: (fps: string) => void;
  onResolutionUpdate: (res: string) => void;
  /** When on, the remote viewport is resized to fill the canvas (no letterbox). */
  adaptiveEnabled: boolean;
  /** When on, tab switches ease focus in/out with a blur (works in both modes). */
  switchBlur: boolean;
  /** Bumped on each successful (re)connect so the override re-applies on a fresh socket. */
  connectEpoch: number;
  /** Bumped the instant a tab switch starts, so the freeze/blur begins immediately. */
  switchSignal: number;
  /** Called when a host-side window resize forces adaptive mode to back off, so the
   *  setting (and its toggle) can reflect that it's no longer active. */
  onAdaptivePaused: () => void;
}

export function Viewport({
  page,
  onFpsUpdate,
  onResolutionUpdate,
  adaptiveEnabled,
  switchBlur,
  connectEpoch,
  switchSignal,
  onAdaptivePaused,
}: ViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef(new Image());
  const imgSizeRef = useRef({ width: 0, height: 0 });
  const frameCountRef = useRef(0);
  const lastFpsTimeRef = useRef(Date.now());

  // Adaptive Viewport controller. The reducer (pure, unit-tested) decides what to do;
  // this component just executes the emitted effects as CDP sends and runs the
  // host-resize poll. `pollable` records whether the Browser domain answered — if not,
  // path A (override) still works but path B (host-resize back-off) stays disabled.
  const adaptiveRef = useRef(initial);
  const adaptiveEnabledRef = useRef(adaptiveEnabled);
  const switchBlurRef = useRef(switchBlur);
  const pollableRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  // While true (during a tab-switch transition), incoming frames are held back: in
  // adaptive mode this hides the reflow jiggle; with blur on it backs the focus pull.
  const settlingRef = useRef(false);
  const settleCapRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Fires once a switched-to tab's frames go quiet (reflow finished), to reveal it.
  // Reset on every frame received during the settle.
  const quietTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // False between a switch starting and its new connection landing — frames before then
  // are stale (old tab) and must not trigger a reveal.
  const connectedSinceSwitchRef = useRef(true);

  // Letterbox the current frame into the canvas at the container's live size.
  // Used both on new frames and on container resize (e.g. sidebar toggle), so
  // the viewport reflows without waiting for the next remote frame.
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const vp = containerRef.current;
    const img = imgRef.current;
    if (!canvas || !vp || !img.width) return;
    const ctx = canvas.getContext("2d")!;

    canvas.width = vp.clientWidth * window.devicePixelRatio;
    canvas.height = vp.clientHeight * window.devicePixelRatio;
    canvas.style.width = vp.clientWidth + "px";
    canvas.style.height = vp.clientHeight + "px";

    const { scale, dx, dy } = letterbox(
      { w: img.width, h: img.height },
      { w: canvas.width, h: canvas.height }
    );

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, dx, dy, img.width * scale, img.height * scale);
  }, []);

  // Re-issue the screencast at the current canvas size. Independent of adaptive mode:
  // off, it caps a letterboxed native frame; on, it matches the just-applied override.
  const reissueScreencast = useCallback(() => {
    const vp = containerRef.current;
    if (!vp) return;
    window.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 80,
      maxWidth: Math.floor(vp.clientWidth * window.devicePixelRatio),
      maxHeight: Math.floor(vp.clientHeight * window.devicePixelRatio),
    });
  }, []);

  // Run the reducer and flush its effects to the active CDP socket.
  const dispatchAdaptive = useCallback((event: AdaptiveEvent) => {
    const { state, effects } = reduce(adaptiveRef.current, event);
    adaptiveRef.current = state;
    for (const eff of effects) {
      if (eff.type === "applyOverride") {
        window.cdp.send("Emulation.setDeviceMetricsOverride", eff.metrics);
      } else {
        window.cdp.send("Emulation.clearDeviceMetricsOverride", {});
      }
    }
    return state;
  }, []);

  // The real OS window rect, unaffected by device-metrics emulation. Null means the
  // Browser domain isn't answering (or we're disconnected) — host-resize detection off.
  const getHostBounds = useCallback(async (): Promise<Bounds | null> => {
    const r = await window.cdp.invoke("Browser.getWindowForTarget");
    const b = r?.bounds;
    return b && typeof b.width === "number" && typeof b.height === "number"
      ? { width: b.width, height: b.height }
      : null;
  }, []);

  const stopPoll = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = undefined;
    }
  }, []);

  const startPoll = useCallback(() => {
    if (pollTimerRef.current || !pollableRef.current) return;
    pollTimerRef.current = setInterval(async () => {
      const s = adaptiveRef.current;
      if (!s.enabled || s.dormant) return stopPoll();
      const bounds = await getHostBounds();
      if (!bounds) return;
      if (dispatchAdaptive({ type: "poll", bounds }).dormant) {
        stopPoll();
        onAdaptivePaused();
      }
    }, 1500);
  }, [dispatchAdaptive, getHostBounds, stopPoll, onAdaptivePaused]);

  // Apply/refresh the override at the live canvas size and re-baseline host bounds.
  const applyAdaptive = useCallback(async () => {
    const vp = containerRef.current;
    if (!vp) return;
    const bounds = await getHostBounds();
    pollableRef.current = bounds !== null;
    dispatchAdaptive({
      type: "resize",
      canvas: { w: vp.clientWidth, h: vp.clientHeight },
      bounds: bounds ?? { width: 0, height: 0 },
    });
  }, [dispatchAdaptive, getHostBounds]);

  // End the tab-switch freeze: paint the latest (now-settled) frame and ease the blur
  // back out — the new tab pulls into focus.
  const revealSettled = useCallback(() => {
    if (!settlingRef.current) return;
    settlingRef.current = false;
    clearTimeout(settleCapRef.current);
    clearTimeout(quietTimerRef.current);
    paint();
    if (canvasRef.current) canvasRef.current.style.filter = "blur(0px)";
  }, [paint]);

  // Draw each frame. While settling after a tab switch, frames are held back until the
  // new tab is ready: adaptive waits for the reflow's frames to go quiet; otherwise the
  // first frame of the new connection reveals. Frames before the new connection lands are
  // stale (old tab) and ignored. Outside a settle, frames paint immediately.
  useEffect(() => {
    const img = imgRef.current;

    img.onload = () => {
      imgSizeRef.current = { width: img.width, height: img.height };

      if (settlingRef.current) {
        if (!connectedSinceSwitchRef.current) return; // stale old-tab frame
        if (adaptiveEnabledRef.current) {
          // Reflowing: hold the last frame, restart the quiet countdown.
          clearTimeout(quietTimerRef.current);
          quietTimerRef.current = setTimeout(revealSettled, FRAMES_QUIET_MS);
        } else {
          // No reflow — the first frame of the new connection is good.
          revealSettled();
        }
        return;
      }

      paint();

      onResolutionUpdate(`${img.width}x${img.height}`);
      frameCountRef.current++;
      const now = Date.now();
      if (now - lastFpsTimeRef.current >= 1000) {
        onFpsUpdate(`${frameCountRef.current} FPS`);
        frameCountRef.current = 0;
        lastFpsTimeRef.current = now;
      }
    };

    return page.onFrame(({ data }) => {
      img.src = "data:image/jpeg;base64," + data;
    });
  }, [page, paint, onFpsUpdate, onResolutionUpdate, revealSettled]);

  // Start at an explicit blur(0px) (not `none`) so the first switch's blur transition
  // interpolates instead of jumping.
  useEffect(() => {
    if (canvasRef.current) canvasRef.current.style.filter = "blur(0px)";
  }, []);

  // The Viewport owns the canvas geometry, so it supplies the coordinate resolver
  // the Remote Page uses to hit-test Input Forwarding.
  useEffect(() => {
    page.setCoordResolver((clientX, clientY) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const { width: w, height: h } = imgSizeRef.current;
      return toRemoteCoords(
        { x: clientX, y: clientY },
        canvas.getBoundingClientRect(),
        window.devicePixelRatio,
        { w, h }
      );
    });
  }, [page]);

  // Any container size change (window resize OR sidebar toggle) repaints the current
  // frame immediately, then (debounced) refreshes the adaptive override and re-issues
  // the screencast at the new size so the remote re-renders at the correct resolution.
  useEffect(() => {
    const vp = containerRef.current;
    if (!vp) return;
    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      paint();
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (adaptiveEnabledRef.current) {
          await applyAdaptive();
          startPoll();
        }
        reissueScreencast();
      }, 150);
    });
    observer.observe(vp);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [paint, applyAdaptive, startPoll, reissueScreencast]);

  // Toggling the setting arms or tears down adaptive mode immediately on the live tab.
  useEffect(() => {
    adaptiveEnabledRef.current = adaptiveEnabled;
    if (adaptiveEnabled) {
      dispatchAdaptive({ type: "enable" });
      applyAdaptive().then(() => {
        reissueScreencast();
        startPoll();
      });
    } else {
      dispatchAdaptive({ type: "disable" }); // emits clearDeviceMetricsOverride
      stopPoll();
      // Drop any in-flight settle so the view never stays frozen/blurred when off.
      settlingRef.current = false;
      clearTimeout(settleCapRef.current);
      clearTimeout(quietTimerRef.current);
      if (canvasRef.current) canvasRef.current.style.filter = "blur(0px)";
      reissueScreencast(); // override gone — frame returns to the host's native size
    }
    return () => stopPoll();
  }, [adaptiveEnabled, dispatchAdaptive, applyAdaptive, startPoll, stopPoll, reissueScreencast]);

  // A tab switch reconnects on a fresh socket. The main process re-applies the cached
  // override before the first frame (so no jiggle), so here we only re-anchor the
  // host-resize baseline and resume the poll — never re-send the override ourselves.
  // Skipped while dormant: a host takeover must not be silently re-armed.
  useEffect(() => {
    switchBlurRef.current = switchBlur;
  }, [switchBlur]);

  useEffect(() => {
    // The new connection has landed: frames from here on are the new tab.
    if (settlingRef.current) connectedSinceSwitchRef.current = true;
    if (!adaptiveEnabledRef.current || adaptiveRef.current.dormant) return;
    getHostBounds().then((bounds) => {
      if (bounds) dispatchAdaptive({ type: "rebaseline", bounds });
      startPoll();
    });
  }, [connectEpoch, getHostBounds, dispatchAdaptive, startPoll]);

  // Freeze the display the instant a tab switch starts (driven by `switchSignal`, before
  // the connect round-trip, so the blur is immediate). Freeze when adaptive (to hide the
  // reflow jiggle) or when blur is on (to back the focus pull). The held frame is revealed
  // once the new tab is ready — see the frame loop — with this cap as a backstop.
  useEffect(() => {
    if (switchSignal === 0) return;
    if (!adaptiveEnabledRef.current && !switchBlurRef.current) return;
    settlingRef.current = true;
    connectedSinceSwitchRef.current = false;
    if (switchBlurRef.current && canvasRef.current) {
      canvasRef.current.style.filter = `blur(${SWITCH_BLUR_PX}px)`;
    }
    clearTimeout(settleCapRef.current);
    settleCapRef.current = setTimeout(revealSettled, SETTLE_CAP_MS);
    return () => clearTimeout(settleCapRef.current);
  }, [switchSignal, revealSettled]);

  // A disconnect only stops the poll; the main process clears the override on the
  // outgoing socket, and the baseline stays valid (the host window is unchanged).
  useEffect(() => {
    return page.on((e) => {
      if (e.type === "disconnected") stopPoll();
    });
  }, [page, stopPoll]);

  // Keyboard forwarding (canvas-level events that aren't app hotkeys go to the page)
  useEffect(() => {
    const isField = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      return tag === "INPUT" || tag === "TEXTAREA";
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isField(e)) return;
      e.preventDefault();
      page.forwardInput({ kind: "key", phase: "down", event: e });
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (isField(e)) return;
      page.forwardInput({ kind: "key", phase: "up", event: e });
    };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keyup", handleKeyUp);
    };
  }, [page]);

  return (
    <div ref={containerRef} className="flex-1 relative bg-black overflow-hidden">
      <canvas
        ref={canvasRef}
        className="w-full h-full block cursor-default transition-[filter] duration-200 ease-out"
        onMouseDown={(e) => {
          e.preventDefault(); // stop native focus/drag stealing the gesture
          // e.detail carries the consecutive-click count: 2 = word, 3 = paragraph
          page.forwardInput({ kind: "mouse", phase: "pressed", event: e, clickCount: e.detail || 1 });
        }}
        onMouseUp={(e) =>
          page.forwardInput({ kind: "mouse", phase: "released", event: e, clickCount: e.detail || 1 })
        }
        onMouseMove={(e) =>
          page.forwardInput({ kind: "mouse", phase: "moved", event: e })
        }
        onContextMenu={(e) => {
          e.preventDefault(); // prevent Electron's native context menu
        }}
        onWheel={(e) => {
          page.forwardInput({ kind: "wheel", event: e });
          e.preventDefault();
        }}
      />
    </div>
  );
}
