import { useCallback, useEffect, useRef } from "react";
import { letterbox, toRemoteCoords } from "@/lib/viewport-transform";
import type { RemotePage } from "@/lib/remote-page";

interface ViewportProps {
  page: RemotePage;
  onFpsUpdate: (fps: string) => void;
  onResolutionUpdate: (res: string) => void;
}

export function Viewport({
  page,
  onFpsUpdate,
  onResolutionUpdate,
}: ViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef(new Image());
  const imgSizeRef = useRef({ width: 0, height: 0 });
  const frameCountRef = useRef(0);
  const lastFpsTimeRef = useRef(Date.now());

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

  // Draw each Screencast Frame; the Remote Page auto-acks, so we only paint.
  useEffect(() => {
    const img = imgRef.current;

    img.onload = () => {
      imgSizeRef.current = { width: img.width, height: img.height };
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
  }, [page, paint, onFpsUpdate, onResolutionUpdate]);

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

  // Any container size change (window resize OR sidebar toggle) repaints the
  // current frame immediately, then re-issues the screencast at the new size so
  // the remote re-renders at the correct resolution.
  useEffect(() => {
    const vp = containerRef.current;
    if (!vp) return;
    let timer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      paint();
      clearTimeout(timer);
      timer = setTimeout(() => {
        window.cdp.send("Page.startScreencast", {
          format: "jpeg",
          quality: 80,
          maxWidth: Math.floor(vp.clientWidth * window.devicePixelRatio),
          maxHeight: Math.floor(vp.clientHeight * window.devicePixelRatio),
        });
      }, 150);
    });
    observer.observe(vp);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [paint]);

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
