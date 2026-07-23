import { describe, expect, it, vi } from "vitest"
import {
  actionsForContext,
  buildActions,
  type ChatAction,
  type ChatContext,
  filterActions,
  groupForOverlay,
} from "./command-registry"

const listCtx: ChatContext = { view: "list" }
const threadCtx: ChatContext = { view: "thread", focusedMessageId: "m1", isOwnMessage: true }

function act(over: Partial<ChatAction> = {}): ChatAction {
  return { id: "a", label: "Action", group: "App", run: () => {}, ...over }
}

describe("buildActions", () => {
  it("drops falsy entries and preserves order", () => {
    const a = act({ id: "a" })
    const b = act({ id: "b" })
    expect(buildActions([a, false, b, null, undefined]).map((x) => x.id)).toEqual(["a", "b"])
  })
  it("returns a fresh array", () => {
    const input = [act()]
    expect(buildActions(input)).not.toBe(input)
  })
})

describe("actionsForContext", () => {
  it("keeps actions with no predicate", () => {
    expect(actionsForContext([act()], listCtx)).toHaveLength(1)
  })
  it("filters by when(ctx)", () => {
    const listOnly = act({ id: "l", when: (c) => c.view === "list" })
    const threadOnly = act({ id: "t", when: (c) => c.view === "thread" })
    expect(actionsForContext([listOnly, threadOnly], listCtx).map((x) => x.id)).toEqual(["l"])
    expect(actionsForContext([listOnly, threadOnly], threadCtx).map((x) => x.id)).toEqual(["t"])
  })
})

describe("filterActions", () => {
  const actions = [
    act({ id: "jump", label: "Jump to conversation" }),
    act({ id: "settings", label: "Settings" }),
    act({ id: "theme", label: "Toggle theme" }),
  ]
  it("returns the same reference on an empty query", () => {
    expect(filterActions(actions, "  ")).toBe(actions)
  })
  it("subsequence matches (fuzzy)", () => {
    expect(filterActions(actions, "jtc").map((a) => a.id)).toEqual(["jump"])
  })
  it("plain substring matches", () => {
    expect(filterActions(actions, "theme").map((a) => a.id)).toEqual(["theme"])
  })
  it("is diacritic + case insensitive", () => {
    const vn = [act({ id: "v", label: "Đà Nẵng team" })]
    expect(filterActions(vn, "da nang").map((a) => a.id)).toEqual(["v"])
  })
  it("returns [] on no match", () => {
    expect(filterActions(actions, "zzz")).toEqual([])
  })
})

describe("groupForOverlay", () => {
  it("includes only actions with a keys hint, grouped, order preserved", () => {
    const actions = [
      act({ id: "next", label: "Next", group: "Navigation", keys: "j" }),
      act({ id: "prev", label: "Prev", group: "Navigation", keys: "k" }),
      act({ id: "nokey", label: "No hint", group: "App" }),
      act({ id: "settings", label: "Settings", group: "App", keys: "⌘," }),
    ]
    const g = groupForOverlay(actions)
    expect(g.Navigation.map((a) => a.id)).toEqual(["next", "prev"])
    expect(g.App.map((a) => a.id)).toEqual(["settings"])
    expect(g.Conversation).toEqual([])
    expect(g.Message).toEqual([])
  })
})

describe("action run is the injected effect", () => {
  it("invokes the run fn", () => {
    const run = vi.fn()
    act({ run }).run()
    expect(run).toHaveBeenCalledOnce()
  })
})
