/**
 * Remote Page — the single live connection to the Active Tab. Wraps the generic CDP
 * transport in named intentions (navigate, back, copySelection…), forwards input, and
 * demuxes the raw event stream into typed subscriptions. Exactly one exists at a time
 * (see docs/adr/0001). The WebSocket itself lives in the main process; this module is
 * the renderer-side funnel over it.
 */

import { modifiers, type ModifierKeys } from "./viewport-transform";

/** The generic transport seam — a structural subset of `window.cdp`. Injected so tests
 *  can pass a fake and assert which CDP calls an intention produces. */
export interface Transport {
  send(method: string, params?: unknown): void;
  invoke(method: string, params?: unknown): Promise<any>;
  onEvent(cb: (msg: { method: string; params?: any }) => void): void;
  onDisconnected(cb: () => void): void;
}

export interface NavState {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** The demuxed event vocabulary callers see — raw CDP method strings never leak past here. */
export type RemotePageEvent =
  | { type: "navigated"; url: string }
  | { type: "loadingChanged"; loading: boolean }
  | { type: "windowOpened" }
  | { type: "disconnected" };

export interface ScreencastFrame {
  /** base64 JPEG, no data: prefix */
  data: string;
  sessionId: number;
}

export type Unsubscribe = () => void;

interface KeyEventLike extends ModifierKeys {
  key: string;
  code: string;
  keyCode: number;
}
interface MouseEventLike extends ModifierKeys {
  clientX: number;
  clientY: number;
  button: number;
  buttons: number;
}
interface WheelEventLike extends ModifierKeys {
  clientX: number;
  clientY: number;
  deltaX: number;
  deltaY: number;
}

/**
 * The single Input Forwarding verb's payload — a tagged union. New input kinds (IME,
 * paste, drag, file) become new variants here plus one case in `forward`; callers and
 * the rest of the interface are untouched. This is the deliberate extension seam.
 */
export type InputIntent =
  | { kind: "key"; phase: "down" | "up"; event: KeyEventLike }
  | { kind: "mouse"; phase: "pressed" | "released" | "moved"; event: MouseEventLike; clickCount?: number }
  | { kind: "wheel"; event: WheelEventLike };

export interface RemotePageOptions {
  /** Maps a client point to Remote Page pixels (the injected Viewport Transform). */
  resolveCoords?: (clientX: number, clientY: number) => { x: number; y: number };
}

const CDP_BUTTON = ["left", "middle", "right"] as const;

/**
 * Synthetic CDP key events bypass macOS's text-editing layer, so Cmd/Alt editing
 * shortcuts (line/word navigation and deletion) do nothing unless we name the editing
 * command explicitly. Maps the common macOS combos to Blink editor command names.
 */
function editingCommands(e: KeyEventLike): string[] {
  const sel = e.shiftKey ? "AndModifySelection" : "";
  if (e.metaKey) {
    switch (e.key) {
      case "ArrowLeft": return ["moveToBeginningOfLine" + sel];
      case "ArrowRight": return ["moveToEndOfLine" + sel];
      case "ArrowUp": return ["moveToBeginningOfDocument" + sel];
      case "ArrowDown": return ["moveToEndOfDocument" + sel];
      case "Backspace": return ["deleteToBeginningOfLine"];
    }
  }
  if (e.altKey) {
    switch (e.key) {
      case "ArrowLeft": return ["moveWordLeft" + sel];
      case "ArrowRight": return ["moveWordRight" + sel];
      case "Backspace": return ["deleteWordBackward"];
    }
  }
  return [];
}

export interface RemotePage {
  navigate(url: string): void;
  reload(): void;
  back(): void;
  forward(): void;
  selectAll(): void;
  getNavState(): Promise<NavState>;
  /** True while the page is still loading (document.readyState !== "complete"). */
  isLoading(): Promise<boolean>;
  copySelection(): Promise<string>;
  /** Draws one screenshot of the current page through onFrame. Forces a paint on
   *  static pages that emit no screencast frame after (re)connect. */
  captureStill(): Promise<boolean>;
  on(cb: (event: RemotePageEvent) => void): Unsubscribe;
  onFrame(cb: (frame: ScreencastFrame) => void): Unsubscribe;
  forwardInput(intent: InputIntent): void;
  /** Late-binds the Viewport Transform — only the Viewport knows the canvas geometry. */
  setCoordResolver(resolve: (clientX: number, clientY: number) => { x: number; y: number }): void;
}

function normalizeUrl(url: string): string {
  return /^https?:\/\//.test(url) ? url : "https://" + url;
}

export function createRemotePage(
  transport: Transport,
  options: RemotePageOptions = {}
): RemotePage {
  let resolveCoords = options.resolveCoords ?? ((x, y) => ({ x, y }));
  const listeners = new Set<(event: RemotePageEvent) => void>();
  const frameListeners = new Set<(frame: ScreencastFrame) => void>();
  const fan = (event: RemotePageEvent) => listeners.forEach((cb) => cb(event));

  // One registration on the raw transport, demuxed to typed subscribers. Subscribers
  // come and go via `on`'s unsubscribe — the transport listener is registered once.
  transport.onEvent((msg) => {
    switch (msg.method) {
      case "Page.screencastFrame": {
        const frame: ScreencastFrame = {
          data: msg.params.data,
          sessionId: msg.params.sessionId,
        };
        frameListeners.forEach((cb) => {
          // A thrown draw must neither stall the ack nor break the event pump.
          try {
            cb(frame);
          } catch {
            /* swallow: drawing errors are non-fatal to the stream */
          }
        });
        transport.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
        break;
      }
      case "Page.frameNavigated":
        if (msg.params?.frame?.url) fan({ type: "navigated", url: msg.params.frame.url });
        break;
      case "Page.frameStartedLoading":
        fan({ type: "loadingChanged", loading: true });
        break;
      case "Page.frameStoppedLoading":
      case "Page.loadEventFired":
        fan({ type: "loadingChanged", loading: false });
        break;
      case "Page.windowOpen":
        fan({ type: "windowOpened" });
        break;
    }
  });
  transport.onDisconnected(() => fan({ type: "disconnected" }));

  return {
    on(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onFrame(cb) {
      frameListeners.add(cb);
      return () => frameListeners.delete(cb);
    },
    setCoordResolver(resolve) {
      resolveCoords = resolve;
    },
    forwardInput(intent) {
      if (intent.kind === "key") {
        const e = intent.event;
        const isDown = intent.phase === "down";
        const commands = isDown ? editingCommands(e) : [];
        transport.send("Input.dispatchKeyEvent", {
          type: isDown ? "keyDown" : "keyUp",
          key: e.key,
          code: e.code,
          text: isDown && e.key.length === 1 ? e.key : "",
          windowsVirtualKeyCode: e.keyCode,
          modifiers: modifiers(e),
          ...(commands.length ? { commands } : {}),
        });
        return;
      }
      if (intent.kind === "wheel") {
        const e = intent.event;
        const { x, y } = resolveCoords(e.clientX, e.clientY);
        transport.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x,
          y,
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          modifiers: modifiers(e),
        });
        return;
      }
      const e = intent.event;
      const { x, y } = resolveCoords(e.clientX, e.clientY);
      if (intent.phase === "moved") {
        // A drag move must name the held button (from the buttons bitmask), else CDP
        // treats it as a plain hover and won't extend a text selection.
        const held =
          e.buttons & 1 ? "left" : e.buttons & 2 ? "right" : e.buttons & 4 ? "middle" : "none";
        transport.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x,
          y,
          button: held,
          buttons: e.buttons,
          modifiers: modifiers(e),
        });
        return;
      }
      transport.send("Input.dispatchMouseEvent", {
        type: intent.phase === "pressed" ? "mousePressed" : "mouseReleased",
        x,
        y,
        button: CDP_BUTTON[e.button] ?? "left",
        buttons: e.buttons,
        clickCount: intent.clickCount ?? 1,
        modifiers: modifiers(e),
      });
    },
    navigate(url) {
      transport.send("Page.navigate", { url: normalizeUrl(url) });
    },
    reload() {
      transport.send("Page.reload", {});
    },
    back() {
      transport.send("Runtime.evaluate", { expression: "history.back()" });
    },
    forward() {
      transport.send("Runtime.evaluate", { expression: "history.forward()" });
    },
    selectAll() {
      transport.send("Runtime.evaluate", {
        expression: "document.execCommand('selectAll')",
      });
    },
    async getNavState() {
      const r = await transport.invoke("Page.getNavigationHistory");
      if (!r || r.error || !r.entries) {
        return { url: "", canGoBack: false, canGoForward: false };
      }
      return {
        url: r.entries[r.currentIndex]?.url ?? "",
        canGoBack: r.currentIndex > 0,
        canGoForward: r.currentIndex < r.entries.length - 1,
      };
    },
    async isLoading() {
      const r = await transport.invoke("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      });
      const state = r?.result?.value;
      return state === "loading" || state === "interactive";
    },
    async copySelection() {
      const r = await transport.invoke("Runtime.evaluate", {
        expression: "document.getSelection().toString()",
        returnByValue: true,
      });
      return r?.result?.value ?? "";
    },
    async captureStill() {
      const r = await transport.invoke("Page.captureScreenshot", {
        format: "jpeg",
        quality: 80,
      });
      if (typeof r?.data !== "string") return false;
      // Deliver as a frame but never ack — a still has no screencast session.
      frameListeners.forEach((cb) => {
        try {
          cb({ data: r.data, sessionId: -1 });
        } catch {
          /* drawing errors are non-fatal */
        }
      });
      return true;
    },
  };
}
