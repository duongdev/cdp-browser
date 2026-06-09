/**
 * Remote Page — the single live connection to the Active Tab. Wraps the generic CDP
 * transport in named intentions (navigate, back, copySelection…), forwards input, and
 * demuxes the raw event stream into typed subscriptions. Exactly one exists at a time
 * (see docs/adr/0001). The WebSocket itself lives in the main process; this module is
 * the renderer-side funnel over it.
 */

import { type ModifierKeys, modifiers } from "./viewport-transform"

/** The generic transport seam — a structural subset of `window.cdp`. Injected so tests
 *  can pass a fake and assert which CDP calls an intention produces. */
export interface Transport {
  send(method: string, params?: unknown): void
  // biome-ignore lint/suspicious/noExplicitAny: CDP responses are dynamic; unknown would force callers to cast every field
  invoke(method: string, params?: unknown): Promise<any>
  // biome-ignore lint/suspicious/noExplicitAny: CDP event params are dynamic
  onEvent(cb: (msg: { method: string; params?: any }) => void): void
  onDisconnected(cb: (phase?: DisconnectPhase) => void): void
}

/** Why the Remote Page socket is down. Web auto-reconnect (t040) surfaces "reconnecting"
 *  while the backoff loop retries and "lost" once it gives up; Electron sends no phase
 *  (undefined ⇒ terminal loss). */
export type DisconnectPhase = "reconnecting" | "lost"

export interface NavState {
  url: string
  canGoBack: boolean
  canGoForward: boolean
}

/** The demuxed event vocabulary callers see — raw CDP method strings never leak past here. */
export type RemotePageEvent =
  | { type: "navigated"; url: string }
  | { type: "loadingChanged"; loading: boolean }
  | { type: "windowOpened" }
  | { type: "disconnected"; phase?: DisconnectPhase }

/** CDP `Page.screencastFrame` metadata — the captured area's DIP geometry, used to map
 *  input back into the remote viewport when the frame is downscaled. */
export interface ScreencastMetadata {
  deviceWidth: number
  deviceHeight: number
  offsetTop: number
  pageScaleFactor: number
  scrollOffsetX: number
  scrollOffsetY: number
}

export interface ScreencastFrame {
  /** base64 JPEG, no data: prefix. Always present from CDP/Electron; on the web build's
   *  binary-WS fast path it's empty and `dataBlob` carries the JPEG bytes instead. */
  data: string
  /** Web build fast path: raw JPEG Blob delivered via a binary WS message, bypassing the
   *  base64 + JSON.parse cost. Viewport prefers this when present. See ADR-0007. */
  dataBlob?: Blob
  sessionId: number
  metadata?: ScreencastMetadata
}

export type Unsubscribe = () => void

interface KeyEventLike extends ModifierKeys {
  key: string
  code: string
  keyCode: number
}
interface MouseEventLike extends ModifierKeys {
  clientX: number
  clientY: number
  button: number
  buttons: number
}
interface WheelEventLike extends ModifierKeys {
  clientX: number
  clientY: number
  deltaX: number
  deltaY: number
}

/**
 * The single Input Forwarding verb's payload — a tagged union. New input kinds (IME,
 * paste, drag, file) become new variants here plus one case in `forward`; callers and
 * the rest of the interface are untouched. This is the deliberate extension seam.
 */
export type InputIntent =
  | { kind: "key"; phase: "down" | "up"; event: KeyEventLike }
  | {
      kind: "mouse"
      phase: "pressed" | "released" | "moved"
      event: MouseEventLike
      clickCount?: number
    }
  | { kind: "wheel"; event: WheelEventLike }

export interface RemotePageOptions {
  /** Maps a client point to Remote Page pixels (the injected Viewport Transform). */
  resolveCoords?: (clientX: number, clientY: number) => { x: number; y: number }
}

const CDP_BUTTON = ["left", "middle", "right"] as const

/**
 * Synthetic CDP key events bypass macOS's text-editing layer, so Cmd/Alt editing
 * shortcuts (line/word navigation and deletion) do nothing unless we name the editing
 * command explicitly. Maps the common macOS combos to Blink editor command names.
 */
function editingCommands(e: KeyEventLike): string[] {
  const sel = e.shiftKey ? "AndModifySelection" : ""
  if (e.metaKey) {
    switch (e.key) {
      case "ArrowLeft":
        return [`moveToBeginningOfLine${sel}`]
      case "ArrowRight":
        return [`moveToEndOfLine${sel}`]
      case "ArrowUp":
        return [`moveToBeginningOfDocument${sel}`]
      case "ArrowDown":
        return [`moveToEndOfDocument${sel}`]
      case "Backspace":
        return ["deleteToBeginningOfLine"]
    }
  }
  if (e.altKey) {
    switch (e.key) {
      case "ArrowLeft":
        return [`moveWordLeft${sel}`]
      case "ArrowRight":
        return [`moveWordRight${sel}`]
      case "Backspace":
        return ["deleteWordBackward"]
    }
  }
  return []
}

/**
 * The injected in-page find helper, installed once per document as `window.__cdpFind`.
 * It owns what `window.find` cannot: counting matches, stepping with wrap, scrolling the
 * current match into view, and a clean clear. Each call re-scans the live DOM (cheap and
 * SPA-proof — no stale node refs across re-renders); the current match is shown via the
 * native Selection so it highlights and reveals without injecting any styles. Ships as a
 * compact IIFE evaluated through `Runtime.evaluate` + `returnByValue` (same precedent as
 * `navigateSpa` / `openTeamsThread`); the named intentions below are the stable seam.
 */
const FIND_HELPER = `(function(){
  if (window.__cdpFind) return;
  var ranges = [], idx = -1;
  function collect(q){
    ranges = [];
    if (!q) return;
    var needle = q.toLowerCase();
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function(n){
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        var p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        var tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
        var st = getComputedStyle(p);
        if (st.visibility === 'hidden' || st.display === 'none') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var node;
    while ((node = walker.nextNode())) {
      var hay = node.nodeValue.toLowerCase(), from = 0, at;
      while ((at = hay.indexOf(needle, from)) !== -1) {
        var r = document.createRange();
        r.setStart(node, at);
        r.setEnd(node, at + needle.length);
        ranges.push(r);
        from = at + needle.length;
      }
    }
  }
  function reveal(){
    var sel = window.getSelection();
    sel.removeAllRanges();
    if (idx < 0 || !ranges[idx]) return;
    sel.addRange(ranges[idx]);
    var el = ranges[idx].startContainer.parentElement;
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
  window.__cdpFind = {
    search: function(q){
      collect(q);
      idx = ranges.length ? 0 : -1;
      reveal();
      return { total: ranges.length, index: idx };
    },
    step: function(dir){
      if (!ranges.length) return { index: -1 };
      idx = dir === 'prev'
        ? (idx - 1 + ranges.length) % ranges.length
        : (idx + 1) % ranges.length;
      reveal();
      return { index: idx };
    },
    clear: function(){
      ranges = []; idx = -1;
      var sel = window.getSelection();
      if (sel) sel.removeAllRanges();
    }
  };
})()`

const findExpr = (call: string) => `(()=>{${FIND_HELPER};return window.__cdpFind.${call}})()`

export interface RemotePage {
  navigate(url: string): void
  /**
   * Client-side navigation within a single-page app (react-router et al.): pushes the
   * URL and dispatches `popstate` so the app's router renders the new route without a
   * document reload. Falls back to a full navigation if `pushState` throws.
   */
  navigateSpa(url: string): void
  /**
   * Opens a Teams v2 conversation by thread id. Teams encodes the conversation nowhere
   * in the URL/history (verified — see ADR-0003), so deep-open replays the click on the
   * chat row whose DOM id carries the thread id (`title-chat-list-item_<threadId>`),
   * retry-polling briefly since a freshly-notified chat takes a beat to render.
   */
  openTeamsThread(threadId: string): void
  reload(): void
  back(): void
  forward(): void
  selectAll(): void
  getNavState(): Promise<NavState>
  /** True while the page is still loading (document.readyState !== "complete"). */
  isLoading(): Promise<boolean>
  copySelection(): Promise<string>
  /**
   * Pastes text into the remote page. When rich=false (default), uses Input.insertText
   * for plain-text insertion into a focused input. When rich=true, pre-seeds the remote
   * clipboard via Runtime.evaluate and forwards Cmd+V so the page's onpaste handler runs.
   */
  paste(text: string, options?: { rich?: boolean }): void
  /**
   * Pastes an image into the remote page's focused element by synthesizing a `paste`
   * ClipboardEvent carrying the image as a File (rich editors read clipboardData.files).
   * `dataUrl` is a `data:image/...;base64,…` string.
   */
  pasteImage(dataUrl: string): void
  /**
   * Pastes an arbitrary file (video, audio, doc, image) into the remote page's
   * focused element by synthesizing a `paste` ClipboardEvent carrying the file as a
   * `File` in a `DataTransfer`. Unlike `pasteImage` this preserves the original file
   * name + MIME type so upload targets that sniff extension/type (Slack, Drive) accept
   * it. `dataUrl` is a `data:<mime>;base64,…` string.
   */
  pasteFile(dataUrl: string, name: string, type: string): void
  /**
   * In-page find (t001). The remote-side search is an injected per-document routine
   * (`window.find` reports only a boolean — it can't count or step deterministically),
   * so a small helper walks the DOM, counts case-insensitive matches, selects + scrolls
   * the current one into view, and reports `{ total, index }` via `returnByValue`.
   */
  find(query: string): Promise<{ total: number }>
  /** Advance to the next/prev match (wrapping), revealing it. Returns the new 0-based index. */
  findStep(dir: "next" | "prev"): Promise<{ index: number }>
  /** Drop the find highlights/selection left on the remote page. */
  clearFind(): void
  on(cb: (event: RemotePageEvent) => void): Unsubscribe
  onFrame(cb: (frame: ScreencastFrame) => void): Unsubscribe
  forwardInput(intent: InputIntent): void
  /** Late-binds the Viewport Transform — only the Viewport knows the canvas geometry. */
  setCoordResolver(resolve: (clientX: number, clientY: number) => { x: number; y: number }): void
}

function normalizeUrl(url: string): string {
  return /^https?:\/\//.test(url) ? url : `https://${url}`
}

export function createRemotePage(
  transport: Transport,
  options: RemotePageOptions = {},
): RemotePage {
  let resolveCoords = options.resolveCoords ?? ((x, y) => ({ x, y }))
  const listeners = new Set<(event: RemotePageEvent) => void>()
  const frameListeners = new Set<(frame: ScreencastFrame) => void>()
  const fan = (event: RemotePageEvent) =>
    listeners.forEach((cb) => {
      cb(event)
    })

  // The top frame's id. Loading events for subframes (Teams keeps long-lived
  // telemetry/presence iframes loading) must not drive the loading bar, else the
  // bar runs forever after a reload. Learned from frameNavigated (main frame has no
  // parentId); seeded from the first loading event when still unknown, and reset on
  // disconnect so each tab tracks its own frame.
  let mainFrameId: string | undefined

  // One registration on the raw transport, demuxed to typed subscribers. Subscribers
  // come and go via `on`'s unsubscribe — the transport listener is registered once.
  transport.onEvent((msg) => {
    switch (msg.method) {
      case "Page.screencastFrame": {
        const frame: ScreencastFrame = {
          // Web build's binary fast path sets `dataBlob` and leaves `data` empty.
          data: msg.params.data ?? "",
          dataBlob: msg.params.dataBlob,
          sessionId: msg.params.sessionId,
          metadata: msg.params.metadata,
        }
        frameListeners.forEach((cb) => {
          // A thrown draw must neither stall the ack nor break the event pump.
          try {
            cb(frame)
          } catch {
            /* swallow: drawing errors are non-fatal to the stream */
          }
        })
        transport.send("Page.screencastFrameAck", { sessionId: frame.sessionId })
        break
      }
      case "Page.frameNavigated": {
        const frame = msg.params?.frame
        if (frame?.url) fan({ type: "navigated", url: frame.url })
        if (frame && !frame.parentId) mainFrameId = frame.id
        break
      }
      case "Page.frameStartedLoading":
        if (mainFrameId === undefined) mainFrameId = msg.params?.frameId
        if (msg.params?.frameId === mainFrameId) fan({ type: "loadingChanged", loading: true })
        break
      case "Page.frameStoppedLoading":
        if (msg.params?.frameId === mainFrameId) fan({ type: "loadingChanged", loading: false })
        break
      case "Page.loadEventFired":
        // Main document finished — authoritative "done" regardless of subframes.
        fan({ type: "loadingChanged", loading: false })
        break
      case "Page.windowOpen":
        fan({ type: "windowOpened" })
        break
    }
  })
  transport.onDisconnected((phase) => {
    mainFrameId = undefined
    fan({ type: "disconnected", phase })
  })

  return {
    on(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    onFrame(cb) {
      frameListeners.add(cb)
      return () => frameListeners.delete(cb)
    },
    setCoordResolver(resolve) {
      resolveCoords = resolve
    },
    forwardInput(intent) {
      if (intent.kind === "key") {
        const e = intent.event
        const isDown = intent.phase === "down"
        const commands = isDown ? editingCommands(e) : []
        transport.send("Input.dispatchKeyEvent", {
          type: isDown ? "keyDown" : "keyUp",
          key: e.key,
          code: e.code,
          text: isDown && e.key.length === 1 ? e.key : "",
          windowsVirtualKeyCode: e.keyCode,
          modifiers: modifiers(e),
          ...(commands.length ? { commands } : {}),
        })
        return
      }
      if (intent.kind === "wheel") {
        const e = intent.event
        const { x, y } = resolveCoords(e.clientX, e.clientY)
        transport.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x,
          y,
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          modifiers: modifiers(e),
        })
        return
      }
      const e = intent.event
      const { x, y } = resolveCoords(e.clientX, e.clientY)
      if (intent.phase === "moved") {
        // A drag move must name the held button (from the buttons bitmask), else CDP
        // treats it as a plain hover and won't extend a text selection.
        const held =
          e.buttons & 1 ? "left" : e.buttons & 2 ? "right" : e.buttons & 4 ? "middle" : "none"
        transport.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x,
          y,
          button: held,
          buttons: e.buttons,
          modifiers: modifiers(e),
        })
        return
      }
      transport.send("Input.dispatchMouseEvent", {
        type: intent.phase === "pressed" ? "mousePressed" : "mouseReleased",
        x,
        y,
        button: CDP_BUTTON[e.button] ?? "left",
        buttons: e.buttons,
        clickCount: intent.clickCount ?? 1,
        modifiers: modifiers(e),
      })
    },
    navigate(url) {
      transport.send("Page.navigate", { url: normalizeUrl(url) })
    },
    navigateSpa(url) {
      const u = JSON.stringify(normalizeUrl(url))
      transport.send("Runtime.evaluate", {
        expression: `(()=>{try{history.pushState({},'',${u});dispatchEvent(new PopStateEvent('popstate',{state:history.state}))}catch(e){location.href=${u}}})()`,
      })
    },
    openTeamsThread(threadId) {
      const id = JSON.stringify(threadId)
      transport.send("Runtime.evaluate", {
        expression: `(()=>{const id=${id};const open=()=>{let t=document.getElementById('title-chat-list-item_'+id)||[...document.querySelectorAll('[id^="title-chat-list-item_"]')].find(e=>e.id.endsWith(id));const row=t&&(t.closest('[role="treeitem"]')||t.closest('li'));if(!row)return false;row.click();return true};if(open())return;let n=0;const iv=setInterval(()=>{if(open()||++n>20)clearInterval(iv)},100)})()`,
      })
    },
    reload() {
      transport.send("Page.reload", {})
    },
    back() {
      transport.send("Runtime.evaluate", { expression: "history.back()" })
    },
    forward() {
      transport.send("Runtime.evaluate", { expression: "history.forward()" })
    },
    selectAll() {
      transport.send("Runtime.evaluate", {
        expression: "document.execCommand('selectAll')",
      })
    },
    async getNavState() {
      const r = await transport.invoke("Page.getNavigationHistory")
      if (!r || r.error || !r.entries) {
        return { url: "", canGoBack: false, canGoForward: false }
      }
      return {
        url: r.entries[r.currentIndex]?.url ?? "",
        canGoBack: r.currentIndex > 0,
        canGoForward: r.currentIndex < r.entries.length - 1,
      }
    },
    async isLoading() {
      const r = await transport.invoke("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      })
      const state = r?.result?.value
      return state === "loading" || state === "interactive"
    },
    async copySelection() {
      const r = await transport.invoke("Runtime.evaluate", {
        expression: "document.getSelection().toString()",
        returnByValue: true,
      })
      return r?.result?.value ?? ""
    },
    async paste(text, { rich = false } = {}) {
      if (rich) {
        await transport.invoke("Runtime.evaluate", {
          expression: `navigator.clipboard.writeText(${JSON.stringify(text)})`,
          awaitPromise: true,
        })
        transport.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "v",
          code: "KeyV",
          commandKey: true,
          windowsVirtualKeyCode: 86,
        })
        transport.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "v",
          code: "KeyV",
          windowsVirtualKeyCode: 86,
        })
      } else {
        transport.send("Input.insertText", { text })
      }
    },
    pasteImage(dataUrl) {
      this.pasteFile(dataUrl, "pasted-image.png", "image/png")
    },
    pasteFile(dataUrl, name, type) {
      // Input.insertText can't carry binary, so synthesize a paste event on the remote's
      // focused element with a DataTransfer holding the File — rich editors / upload
      // surfaces (Slack, Gmail, Drive) that listen for `paste` read it from
      // clipboardData.files. Name + type are preserved so the target accepts the file
      // (a video needs its real extension/MIME, not a generic image).
      transport.invoke("Runtime.evaluate", {
        expression: `(async () => {
          const res = await fetch(${JSON.stringify(dataUrl)});
          const blob = await res.blob();
          const file = new File([blob], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} || blob.type || "application/octet-stream" });
          const dt = new DataTransfer();
          dt.items.add(file);
          const el = document.activeElement || document.body;
          el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
        })()`,
        awaitPromise: true,
      })
    },
    async find(query) {
      const q = JSON.stringify(query)
      const r = await transport.invoke("Runtime.evaluate", {
        expression: findExpr(`search(${q})`),
        returnByValue: true,
      })
      return { total: r?.result?.value?.total ?? 0 }
    },
    async findStep(dir) {
      const d = JSON.stringify(dir)
      const r = await transport.invoke("Runtime.evaluate", {
        expression: findExpr(`step(${d})`),
        returnByValue: true,
      })
      return { index: r?.result?.value?.index ?? -1 }
    },
    clearFind() {
      transport.send("Runtime.evaluate", { expression: findExpr("clear()") })
    },
  }
}
