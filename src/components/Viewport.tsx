import { useEffect, useRef, useCallback } from "react";
import { Globe, Settings } from "lucide-react";

interface ViewportProps {
  loading: boolean;
  loadingText: string;
  onFpsUpdate: (fps: string) => void;
  onResolutionUpdate: (res: string) => void;
  onOpenSettings?: () => void;
}

export function Viewport({
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

  const getPos = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };

      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio;
      const cw = rect.width * dpr;
      const ch = rect.height * dpr;
      const { width: imgWidth, height: imgHeight } = imgSizeRef.current;

      const scale = Math.min(cw / imgWidth, ch / imgHeight);
      const dw = imgWidth * scale;
      const dh = imgHeight * scale;
      const dx = (cw - dw) / 2;
      const dy = (ch - dh) / 2;

      const px = (e.clientX - rect.left) * dpr;
      const py = (e.clientY - rect.top) * dpr;

      return {
        x: Math.round((px - dx) / scale),
        y: Math.round((py - dy) / scale),
      };
    },
    []
  );

  // Screencast frame handler
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const img = imgRef.current;

    window.cdp.onEvent((msg: any) => {
      if (msg.method === "Page.screencastFrame") {
        const { data, sessionId } = msg.params;

        img.onload = () => {
          imgSizeRef.current = { width: img.width, height: img.height };

          const vp = containerRef.current;
          if (!vp) return;

          canvas.width = vp.clientWidth * window.devicePixelRatio;
          canvas.height = vp.clientHeight * window.devicePixelRatio;
          canvas.style.width = vp.clientWidth + "px";
          canvas.style.height = vp.clientHeight + "px";

          const scale = Math.min(
            canvas.width / img.width,
            canvas.height / img.height
          );
          const dw = img.width * scale;
          const dh = img.height * scale;
          const dx = (canvas.width - dw) / 2;
          const dy = (canvas.height - dh) / 2;

          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, dx, dy, dw, dh);

          onResolutionUpdate(`${img.width}x${img.height}`);
          frameCountRef.current++;
          const now = Date.now();
          if (now - lastFpsTimeRef.current >= 1000) {
            onFpsUpdate(`${frameCountRef.current} FPS`);
            frameCountRef.current = 0;
            lastFpsTimeRef.current = now;
          }
        };
        img.src = "data:image/jpeg;base64," + data;
        window.cdp.send("Page.screencastFrameAck", { sessionId });
      }
    });
  }, [onFpsUpdate, onResolutionUpdate]);

  // Resize handler
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

  // Keyboard forwarding
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement).tagName === "INPUT" ||
        (e.target as HTMLElement).tagName === "TEXTAREA"
      )
        return;
      e.preventDefault();
      let m = 0;
      if (e.altKey) m |= 1;
      if (e.ctrlKey) m |= 2;
      if (e.metaKey) m |= 4;
      if (e.shiftKey) m |= 8;
      window.cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: e.key,
        code: e.code,
        text: e.key.length === 1 ? e.key : "",
        windowsVirtualKeyCode: e.keyCode,
        modifiers: m,
      });
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement).tagName === "INPUT" ||
        (e.target as HTMLElement).tagName === "TEXTAREA"
      )
        return;
      let m = 0;
      if (e.altKey) m |= 1;
      if (e.ctrlKey) m |= 2;
      if (e.metaKey) m |= 4;
      if (e.shiftKey) m |= 8;
      window.cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: e.key,
        code: e.code,
        windowsVirtualKeyCode: e.keyCode,
        modifiers: m,
      });
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  const handleMouse = useCallback(
    (type: string, e: React.MouseEvent<HTMLCanvasElement>, clickCount = 1) => {
      const pos = getPos(e);
      window.cdp.send("Input.dispatchMouseEvent", {
        type,
        x: pos.x,
        y: pos.y,
        button: "left",
        clickCount,
      });
    },
    [getPos]
  );

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
        onMouseDown={(e) => handleMouse("mousePressed", e)}
        onMouseUp={(e) => handleMouse("mouseReleased", e)}
        onMouseMove={(e) => {
          const pos = getPos(e);
          window.cdp.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: pos.x,
            y: pos.y,
          });
        }}
        onDoubleClick={(e) => {
          handleMouse("mousePressed", e, 2);
          handleMouse("mouseReleased", e, 2);
        }}
        onWheel={(e) => {
          const pos = getPos(e);
          window.cdp.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: pos.x,
            y: pos.y,
            deltaX: e.deltaX,
            deltaY: e.deltaY,
          });
          e.preventDefault();
        }}
      />
    </div>
  );
}
