import { describe, it, expect, vi } from "vitest";
import { createRemotePage, type Transport } from "./remote-page";

/** A fake CDP transport: records sends, scripts invoke results, and replays events. */
function fakeTransport() {
  let eventCb: ((msg: { method: string; params?: any }) => void) | null = null;
  let disconnectedCb: (() => void) | null = null;
  const sends: Array<{ method: string; params: any }> = [];
  const invoke = vi.fn(async (_method: string, _params?: any) => ({}) as any);
  const transport: Transport = {
    send: (method, params) => sends.push({ method, params }),
    invoke,
    onEvent: (cb) => {
      eventCb = cb;
    },
    onDisconnected: (cb) => {
      disconnectedCb = cb;
    },
  };
  return {
    transport,
    sends,
    invoke,
    emit: (method: string, params?: any) => eventCb?.({ method, params }),
    emitDisconnected: () => disconnectedCb?.(),
  };
}

describe("RemotePage navigation state", () => {
  it("derives canGoBack/canGoForward and the current url from history", async () => {
    const t = fakeTransport();
    t.invoke.mockResolvedValue({
      currentIndex: 1,
      entries: [{ url: "a" }, { url: "b" }, { url: "c" }],
    });
    const page = createRemotePage(t.transport);

    const state = await page.getNavState();

    expect(t.invoke).toHaveBeenCalledWith("Page.getNavigationHistory");
    expect(state).toEqual({ url: "b", canGoBack: true, canGoForward: true });
  });

  it("returns a safe default when the query errors", async () => {
    const t = fakeTransport();
    t.invoke.mockResolvedValue({ error: "not connected" });
    const state = await createRemotePage(t.transport).getNavState();
    expect(state).toEqual({ url: "", canGoBack: false, canGoForward: false });
  });
});

describe("RemotePage event demux", () => {
  it("maps raw CDP events to a typed RemotePageEvent stream", () => {
    const t = fakeTransport();
    const page = createRemotePage(t.transport);
    const events: any[] = [];
    page.on((e) => events.push(e));

    t.emit("Page.frameNavigated", { frame: { url: "https://x.com" } });
    t.emit("Page.frameStartedLoading", {});
    t.emit("Page.loadEventFired", {});
    t.emit("Page.windowOpen", {});
    t.emitDisconnected();

    expect(events).toEqual([
      { type: "navigated", url: "https://x.com" },
      { type: "loadingChanged", loading: true },
      { type: "loadingChanged", loading: false },
      { type: "windowOpened" },
      { type: "disconnected" },
    ]);
  });

  it("stops delivering after unsubscribe (no listener leak)", () => {
    const t = fakeTransport();
    const page = createRemotePage(t.transport);
    const events: any[] = [];
    const off = page.on((e) => events.push(e));

    t.emit("Page.windowOpen", {});
    off();
    t.emit("Page.windowOpen", {});

    expect(events).toHaveLength(1);
  });
});

describe("RemotePage input forwarding", () => {
  const noMods = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

  it("forwards a key-down with text, virtual key code, and modifier bitmask", () => {
    const t = fakeTransport();
    const page = createRemotePage(t.transport);

    page.forwardInput({
      kind: "key",
      phase: "down",
      event: { ...noMods, metaKey: true, key: "a", code: "KeyA", keyCode: 65 },
    });

    expect(t.sends).toEqual([
      {
        method: "Input.dispatchKeyEvent",
        params: {
          type: "keyDown",
          key: "a",
          code: "KeyA",
          text: "a",
          windowsVirtualKeyCode: 65,
          modifiers: 4,
        },
      },
    ]);
  });

  it("omits text on key-up and for non-printable keys", () => {
    const t = fakeTransport();
    const page = createRemotePage(t.transport);

    page.forwardInput({ kind: "key", phase: "up", event: { ...noMods, key: "a", code: "KeyA", keyCode: 65 } });
    page.forwardInput({ kind: "key", phase: "down", event: { ...noMods, key: "Enter", code: "Enter", keyCode: 13 } });

    expect(t.sends[0].params.text).toBe("");
    expect(t.sends[1].params.text).toBe("");
  });

  it("maps mouse buttons and applies the injected coordinate resolver", () => {
    const t = fakeTransport();
    const page = createRemotePage(t.transport, {
      resolveCoords: (x, y) => ({ x: x + 1, y: y + 2 }),
    });

    page.forwardInput({
      kind: "mouse",
      phase: "pressed",
      clickCount: 1,
      event: { ...noMods, clientX: 10, clientY: 20, button: 2, buttons: 2 },
    });

    expect(t.sends).toEqual([
      {
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mousePressed",
          x: 11,
          y: 22,
          button: "right",
          buttons: 2,
          clickCount: 1,
          modifiers: 0,
        },
      },
    ]);
  });

  it("attaches macOS editing commands for Cmd/Alt navigation and deletion keys", () => {
    const t = fakeTransport();
    const page = createRemotePage(t.transport);

    page.forwardInput({ kind: "key", phase: "down", event: { ...noMods, metaKey: true, key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 } });
    page.forwardInput({ kind: "key", phase: "down", event: { ...noMods, metaKey: true, shiftKey: true, key: "ArrowRight", code: "ArrowRight", keyCode: 39 } });
    page.forwardInput({ kind: "key", phase: "down", event: { ...noMods, metaKey: true, key: "Backspace", code: "Backspace", keyCode: 8 } });
    page.forwardInput({ kind: "key", phase: "down", event: { ...noMods, altKey: true, key: "Backspace", code: "Backspace", keyCode: 8 } });

    expect(t.sends.map((s) => s.params.commands)).toEqual([
      ["moveToBeginningOfLine"],
      ["moveToEndOfLineAndModifySelection"],
      ["deleteToBeginningOfLine"],
      ["deleteWordBackward"],
    ]);
  });

  it("omits the commands field for plain keys and on key-up", () => {
    const t = fakeTransport();
    const page = createRemotePage(t.transport);

    page.forwardInput({ kind: "key", phase: "down", event: { ...noMods, key: "a", code: "KeyA", keyCode: 65 } });
    page.forwardInput({ kind: "key", phase: "up", event: { ...noMods, metaKey: true, key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 } });

    expect(t.sends[0].params).not.toHaveProperty("commands");
    expect(t.sends[1].params).not.toHaveProperty("commands");
  });

  it("uses a coordinate resolver set after creation (late-bound by the Viewport)", () => {
    const t = fakeTransport();
    const page = createRemotePage(t.transport);
    page.setCoordResolver((x, y) => ({ x: x * 10, y: y * 10 }));

    page.forwardInput({
      kind: "mouse",
      phase: "moved",
      event: { ...noMods, clientX: 3, clientY: 4, button: 0, buttons: 0 },
    });

    expect(t.sends[0].params).toMatchObject({ x: 30, y: 40 });
  });

  it("includes the held button on a drag move so CDP extends selection", () => {
    const t = fakeTransport();
    const page = createRemotePage(t.transport, { resolveCoords: (x, y) => ({ x, y }) });

    // left button held (buttons bitmask = 1) while moving
    page.forwardInput({
      kind: "mouse",
      phase: "moved",
      event: { ...noMods, clientX: 1, clientY: 2, button: 0, buttons: 1 },
    });
    // plain hover, nothing held
    page.forwardInput({
      kind: "mouse",
      phase: "moved",
      event: { ...noMods, clientX: 1, clientY: 2, button: 0, buttons: 0 },
    });

    expect(t.sends[0].params).toMatchObject({ type: "mouseMoved", button: "left", buttons: 1 });
    expect(t.sends[1].params).toMatchObject({ type: "mouseMoved", button: "none", buttons: 0 });
  });

  it("forwards a wheel event with deltas at the resolved position", () => {
    const t = fakeTransport();
    const page = createRemotePage(t.transport, { resolveCoords: (x, y) => ({ x, y }) });

    page.forwardInput({
      kind: "wheel",
      event: { ...noMods, clientX: 5, clientY: 6, deltaX: 3, deltaY: -4 },
    });

    expect(t.sends).toEqual([
      {
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseWheel", x: 5, y: 6, deltaX: 3, deltaY: -4, modifiers: 0 },
      },
    ]);
  });
});

describe("RemotePage screencast frames", () => {
  it("delivers frames to onFrame and auto-acks the session", () => {
    const t = fakeTransport();
    const page = createRemotePage(t.transport);
    const frames: any[] = [];
    page.onFrame((f) => frames.push(f));

    t.emit("Page.screencastFrame", { data: "BASE64", sessionId: 7 });

    expect(frames).toEqual([{ data: "BASE64", sessionId: 7 }]);
    expect(t.sends).toContainEqual({
      method: "Page.screencastFrameAck",
      params: { sessionId: 7 },
    });
  });

  it("does not route frames to the on() event stream", () => {
    const t = fakeTransport();
    const page = createRemotePage(t.transport);
    const events: any[] = [];
    page.on((e) => events.push(e));

    t.emit("Page.screencastFrame", { data: "x", sessionId: 1 });

    expect(events).toHaveLength(0);
  });

  it("acks even when the frame handler throws", () => {
    const t = fakeTransport();
    const page = createRemotePage(t.transport);
    page.onFrame(() => {
      throw new Error("draw failed");
    });

    expect(() => t.emit("Page.screencastFrame", { data: "x", sessionId: 9 })).not.toThrow();
    expect(t.sends).toContainEqual({
      method: "Page.screencastFrameAck",
      params: { sessionId: 9 },
    });
  });
});

describe("RemotePage isLoading", () => {
  it("is true while the document is not complete", async () => {
    const t = fakeTransport();
    t.invoke.mockResolvedValue({ result: { value: "loading" } });
    const loading = await createRemotePage(t.transport).isLoading();
    expect(t.invoke).toHaveBeenCalledWith("Runtime.evaluate", {
      expression: "document.readyState",
      returnByValue: true,
    });
    expect(loading).toBe(true);
  });

  it("is false once complete, and false on error (never blocks the UI)", async () => {
    const t = fakeTransport();
    t.invoke.mockResolvedValueOnce({ result: { value: "complete" } });
    expect(await createRemotePage(t.transport).isLoading()).toBe(false);
    t.invoke.mockResolvedValueOnce({ error: "timeout" });
    expect(await createRemotePage(t.transport).isLoading()).toBe(false);
  });
});

describe("RemotePage copySelection", () => {
  it("returns the remote selection text, unwrapping the evaluate result", async () => {
    const t = fakeTransport();
    t.invoke.mockResolvedValue({ result: { value: "selected text" } });

    const text = await createRemotePage(t.transport).copySelection();

    expect(t.invoke).toHaveBeenCalledWith("Runtime.evaluate", {
      expression: "document.getSelection().toString()",
      returnByValue: true,
    });
    expect(text).toBe("selected text");
  });

  it("returns an empty string when nothing is selected or the query errors", async () => {
    const t = fakeTransport();
    t.invoke.mockResolvedValue({ error: "timeout" });
    expect(await createRemotePage(t.transport).copySelection()).toBe("");
  });
});

describe("RemotePage navigation", () => {
  it("navigate normalizes a bare host to https and sends Page.navigate", () => {
    const t = fakeTransport();
    const page = createRemotePage(t.transport);

    page.navigate("example.com");

    expect(t.sends).toEqual([
      { method: "Page.navigate", params: { url: "https://example.com" } },
    ]);
  });

  it("leaves an explicit scheme untouched", () => {
    const t = fakeTransport();
    createRemotePage(t.transport).navigate("http://localhost:3000");
    expect(t.sends[0].params).toEqual({ url: "http://localhost:3000" });
  });

  it("reload sends Page.reload; back/forward go through history; selectAll uses execCommand", () => {
    const t = fakeTransport();
    const page = createRemotePage(t.transport);

    page.reload();
    page.back();
    page.forward();
    page.selectAll();

    expect(t.sends).toEqual([
      { method: "Page.reload", params: {} },
      { method: "Runtime.evaluate", params: { expression: "history.back()" } },
      { method: "Runtime.evaluate", params: { expression: "history.forward()" } },
      { method: "Runtime.evaluate", params: { expression: "document.execCommand('selectAll')" } },
    ]);
  });
});
