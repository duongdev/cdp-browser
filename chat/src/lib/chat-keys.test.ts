import { describe, expect, it } from "vitest"
import { isEditableTarget, type KeyLike, routeKey } from "./chat-keys"
import type { ChatContext } from "./command-registry"

const list: ChatContext = { view: "list" }
const thread: ChatContext = { view: "thread", focusedMessageId: "m1", isOwnMessage: true }

function key(k: string, over: Partial<KeyLike> = {}): KeyLike {
  return { key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over }
}

describe("isEditableTarget", () => {
  it("detects input/textarea/select", () => {
    for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(isEditableTarget({ tagName: tag } as unknown as EventTarget)).toBe(true)
    }
  })
  it("detects contenteditable", () => {
    expect(
      isEditableTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget),
    ).toBe(true)
  })
  it("is false for a plain div / null", () => {
    expect(isEditableTarget({ tagName: "DIV" } as unknown as EventTarget)).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})

describe("routeKey — global modifier shortcuts", () => {
  it("⌘K / Ctrl+K → palette, even in the composer", () => {
    const inField = { tagName: "TEXTAREA" } as unknown as EventTarget
    expect(routeKey(key("k", { metaKey: true, target: inField }), list, false)).toEqual({
      type: "palette",
    })
    expect(routeKey(key("K", { ctrlKey: true }), thread, false)).toEqual({ type: "palette" })
  })
  it("⌘/ → overlay, even in the composer", () => {
    const inField = { tagName: "INPUT" } as unknown as EventTarget
    expect(routeKey(key("/", { metaKey: true, target: inField }), list, false)).toEqual({
      type: "overlay",
    })
  })
  it("⌘, → settings, even in the composer", () => {
    const inField = { tagName: "TEXTAREA" } as unknown as EventTarget
    expect(routeKey(key(",", { metaKey: true, target: inField }), thread, false)).toEqual({
      type: "settings",
    })
  })
  it("⌘1..⌘9 → conv-index with the digit, even in a field", () => {
    const inField = { tagName: "INPUT" } as unknown as EventTarget
    expect(routeKey(key("3", { metaKey: true, target: inField }), list, false)).toEqual({
      type: "conv-index",
      index: 3,
    })
    expect(routeKey(key("0", { metaKey: true }), list, false)).toBeNull()
  })
})

describe("routeKey — conversation switch (⌘⇧[/⌘⇧])", () => {
  it("⌘⇧[ → conv-prev, ⌘⇧] → conv-next", () => {
    expect(routeKey(key("[", { metaKey: true, shiftKey: true }), thread, false)).toEqual({
      type: "conv-prev",
    })
    expect(routeKey(key("]", { metaKey: true, shiftKey: true }), list, false)).toEqual({
      type: "conv-next",
    })
  })
  it("fires even while the composer is focused", () => {
    expect(
      routeKey(
        key("[", { metaKey: true, shiftKey: true }),
        { ...thread, composerFocused: true },
        false,
      ),
    ).toEqual({ type: "conv-prev" })
    expect(
      routeKey(
        key("]", { metaKey: true, shiftKey: true }),
        { ...thread, composerFocused: true },
        false,
      ),
    ).toEqual({ type: "conv-next" })
  })
  it("fires even when the event target is a text field", () => {
    const t = { tagName: "TEXTAREA" } as unknown as EventTarget
    expect(routeKey(key("[", { metaKey: true, shiftKey: true, target: t }), thread, false)).toEqual(
      {
        type: "conv-prev",
      },
    )
    expect(routeKey(key("]", { metaKey: true, shiftKey: true, target: t }), thread, false)).toEqual(
      {
        type: "conv-next",
      },
    )
  })
  it("⌥↑ / ⌥↓ no longer switch conversations", () => {
    expect(routeKey(key("ArrowDown", { altKey: true }), thread, false)).toBeNull()
    expect(routeKey(key("ArrowUp", { altKey: true }), list, false)).toBeNull()
  })
})

describe("routeKey — focus composer (i / /)", () => {
  it("i → focus-composer only in a thread", () => {
    expect(routeKey(key("i"), thread, false)).toEqual({ type: "focus-composer" })
    expect(routeKey(key("i"), list, false)).toBeNull()
  })
  it("does not fire while a text field is focused", () => {
    const t = { tagName: "TEXTAREA" } as unknown as EventTarget
    expect(routeKey(key("i", { target: t }), thread, false)).toBeNull()
  })
  it("/ → focus-composer only in a thread, only when not in a text field", () => {
    expect(routeKey(key("/"), thread, false)).toEqual({ type: "focus-composer" })
    expect(routeKey(key("/"), list, false)).toBeNull()
  })
  it("/ does not fire while a text field is focused", () => {
    const t = { tagName: "TEXTAREA" } as unknown as EventTarget
    expect(routeKey(key("/", { target: t }), thread, false)).toBeNull()
  })
  it("/ does not fire while composerFocused is true", () => {
    expect(routeKey(key("/"), { ...thread, composerFocused: true }, false)).toBeNull()
  })
})

describe("routeKey — text-field guard", () => {
  it("suppresses every bare-char shortcut in a text field", () => {
    const t = { tagName: "TEXTAREA" } as unknown as EventTarget
    for (const k of ["j", "k", "g", "e", "r", "?", "Enter", "Backspace"]) {
      expect(routeKey(key(k, { target: t }), thread, false)).toBeNull()
    }
  })
  it("suppresses bare-char shortcuts when composerFocused is set", () => {
    expect(routeKey(key("j"), { ...list, composerFocused: true }, false)).toBeNull()
  })
  it("suppresses bare-char shortcuts when a chord modifier is held", () => {
    expect(routeKey(key("j", { altKey: true }), list, false)).toBeNull()
  })
})

describe("routeKey — navigation", () => {
  it("j / ArrowDown → focus-next", () => {
    expect(routeKey(key("j"), list, false)).toEqual({ type: "focus-next" })
    expect(routeKey(key("ArrowDown"), list, false)).toEqual({ type: "focus-next" })
  })
  it("k / ArrowUp → focus-prev", () => {
    expect(routeKey(key("k"), list, false)).toEqual({ type: "focus-prev" })
    expect(routeKey(key("ArrowUp"), thread, false)).toEqual({ type: "focus-prev" })
  })
  it("Enter opens only in the list", () => {
    expect(routeKey(key("Enter"), list, false)).toEqual({ type: "open" })
    expect(routeKey(key("Enter"), thread, false)).toBeNull()
  })
  it("? → overlay", () => {
    expect(routeKey(key("?"), list, false)).toEqual({ type: "overlay" })
  })
})

describe("routeKey — g sequence", () => {
  it("g → g-prefix", () => {
    expect(routeKey(key("g"), list, false)).toEqual({ type: "g-prefix" })
  })
  it("pending g + i → go-inbox", () => {
    expect(routeKey(key("i"), thread, true)).toEqual({ type: "go-inbox" })
  })
  it("pending g + any other key → null (sequence ends)", () => {
    expect(routeKey(key("x"), thread, true)).toBeNull()
  })
})

describe("routeKey — message actions (thread + own only)", () => {
  it("e → edit only for own message in thread", () => {
    expect(routeKey(key("e"), thread, false)).toEqual({ type: "edit" })
    expect(routeKey(key("e"), { ...thread, isOwnMessage: false }, false)).toBeNull()
    expect(routeKey(key("e"), list, false)).toBeNull()
  })
  it("Backspace / Delete → delete only for own message in thread", () => {
    expect(routeKey(key("Backspace"), thread, false)).toEqual({ type: "delete" })
    expect(routeKey(key("Delete"), thread, false)).toEqual({ type: "delete" })
    expect(routeKey(key("Backspace"), { ...thread, isOwnMessage: false }, false)).toBeNull()
  })
  it("r → react for any focused message in thread", () => {
    expect(routeKey(key("r"), thread, false)).toEqual({ type: "react" })
    expect(routeKey(key("r"), { ...thread, isOwnMessage: false }, false)).toEqual({ type: "react" })
    expect(routeKey(key("r"), { view: "thread" }, false)).toBeNull()
    expect(routeKey(key("r"), list, false)).toBeNull()
  })
  it("u → toggle-read when a conversation is focused/open (t155)", () => {
    expect(routeKey(key("u"), { view: "list", focusedConversationId: "c1" }, false)).toEqual({
      type: "toggle-read",
    })
    expect(routeKey(key("u"), { view: "thread", focusedConversationId: "c1" }, false)).toEqual({
      type: "toggle-read",
    })
    expect(routeKey(key("u"), list, false)).toBeNull()
  })
})

describe("routeKey — Esc is never claimed", () => {
  it("returns null for Escape (owned by palette/lightbox/edit)", () => {
    expect(routeKey(key("Escape"), list, false)).toBeNull()
    expect(routeKey(key("Escape"), thread, false)).toBeNull()
  })
})
