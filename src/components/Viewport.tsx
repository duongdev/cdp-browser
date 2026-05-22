import { useEffect, useRef } from "react";
import { Globe, Settings } from "lucide-react";
import { letterbox, toRemoteCoords } from "@/lib/viewport-transform";
import type { RemotePage } from "@/lib/remote-page";

interface ViewportProps {
  page: RemotePage;
  loading: boolean;
  loadingText: string;
  onFpsUpdate: (fps: string) => void;
  onResolutionUpdate: (res: string) => void;
  onOpenSettings?: () => void;
}

export function Viewport({
  page,
  loading,
  loadingText,
  onFpsUpdate,
  onResolutionUpdate,
  onOpenSettings,
}: ViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef(new Image());
  const imgSizeRef = useRef({ width: 0, height: 0 });
  const frameCountRef = useRef(0);
  const lastFpsTimeRef = useRef(Date.now());

  // Draw each Screencast Frame; the Remote Page auto-acks, so we only paint.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const img = imgRef.current;

    img.onload = () => {
      imgSizeRef.current = { width: img.width, height: img.height };

      const vp = containerRef.current;
      if (!vp) return;

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
  }, [page, onFpsUpdate, onResolutionUpdate]);

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

  // Resize re-issues the screencast at the new canvas size (screencast config).
  useEffect(() => {
    const handleResize = () => {
      const vp = containerRef.current;
      if (!vp) return;
      window.cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 80,
        maxWidth: Math.floor(vp.clientWidth * window.devicePixelRatio),
        maxHeight: Math.floor(vp.clientHeight * window.devicePixelRatio),
      });
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

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
      {loading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center z-10 gap-3">
          {loadingText.startsWith("Error") ? (
            <>
              <Globe className="size-10 text-muted-foreground/40" />
              <span className="text-sm text-muted-foreground">
                {loadingText}
              </span>
              {onOpenSettings && (
                <button
                  onClick={onOpenSettings}
                  className="flex items-center gap-1.5 text-xs text-primary hover:underline mt-1"
                >
                  <Settings className="size-3" />
                  Check connection settings
                </button>
              )}
            </>
          ) : (
            <span className="text-sm text-muted-foreground animate-pulse">
              {loadingText}
            </span>
          )}
        </div>
      )}
      <canvas
        ref={canvasRef}
        className="w-full h-full block cursor-default"
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
