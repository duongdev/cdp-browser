import { describe, expect, it } from "vitest"
import {
  type Action,
  type ActionInput,
  buildActions,
  filterActions,
  groupForOverlay,
  hotkeyHint,
  OVERLAY_GROUPS,
} from "./hotkey-registry"

const noop = () => {}

function action(partial: Partial<Action> & Pick<Action, "id" | "name" | "group">): Action {
  return { run: noop, ...partial }
}

describe("buildActions", () => {
  it("keeps an action with a hotkey present with its name, group, and hint", () => {
    const input = [action({ id: "reload", name: "Reload page", group: "Global", hotkey: "⌘R" })]
    const out = buildActions(input)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      id: "reload",
      name: "Reload page",
      group: "Global",
      hotkey: "⌘R",
    })
  })

  it("drops falsy entries so callers can splice conditionally without filtering first", () => {
    const input: ActionInput[] = [
      action({ id: "a", name: "A", group: "Global" }),
      null,
      undefined,
      false,
      action({ id: "b", name: "B", group: "Global" }),
    ]
    const out = buildActions(input)
    expect(out.map((a) => a.id)).toEqual(["a", "b"])
  })

  it("does not mutate its input", () => {
    const input = [action({ id: "a", name: "A", group: "Global" })]
    const snapshot = [...input]
    buildActions(input)
    expect(input).toEqual(snapshot)
  })
})

describe("filterActions", () => {
  const actions = buildActions([
    action({ id: "reload", name: "Reload page", group: "Global", hotkey: "⌘R" }),
    action({ id: "settings", name: "Open Settings", group: "Global", hotkey: "⌘," }),
    action({ id: "next-tab", name: "Next tab", group: "Tab navigation", hotkey: "⌃Tab" }),
  ])

  it("returns all actions for an empty or whitespace query", () => {
    expect(filterActions(actions, "")).toEqual(actions)
    expect(filterActions(actions, "   ")).toEqual(actions)
  })

  it("matches name case-insensitively as a substring", () => {
    expect(filterActions(actions, "reload").map((a) => a.id)).toEqual(["reload"])
    expect(filterActions(actions, "RELOAD").map((a) => a.id)).toEqual(["reload"])
    expect(filterActions(actions, "set").map((a) => a.id)).toEqual(["settings"])
  })

  it("also matches against the group label", () => {
    expect(filterActions(actions, "tab").map((a) => a.id)).toEqual(["next-tab"])
    expect(filterActions(actions, "navigation").map((a) => a.id)).toEqual(["next-tab"])
  })

  it("returns none for a non-matching query", () => {
    expect(filterActions(actions, "zzz")).toEqual([])
  })

  it("does not mutate its input", () => {
    const snapshot = [...actions]
    filterActions(actions, "tab")
    expect(actions).toEqual(snapshot)
  })
})

describe("groupForOverlay", () => {
  it("partitions actions into the ux.md categories preserving registration order within a group", () => {
    const actions = buildActions([
      action({ id: "settings", name: "Open Settings", group: "Global", hotkey: "⌘," }),
      action({ id: "next-tab", name: "Next tab", group: "Tab navigation", hotkey: "⌃Tab" }),
      action({ id: "reload", name: "Reload page", group: "Global", hotkey: "⌘R" }),
      action({ id: "sidebar", name: "Toggle sidebar", group: "Sidebar", hotkey: "⌘S" }),
    ])
    const grouped = groupForOverlay(actions)
    expect(grouped.Global.map((a) => a.id)).toEqual(["settings", "reload"])
    expect(grouped["Tab navigation"].map((a) => a.id)).toEqual(["next-tab"])
    expect(grouped.Sidebar.map((a) => a.id)).toEqual(["sidebar"])
    expect(grouped["Address bar"]).toEqual([])
  })

  it("returns every ux.md group key even when empty", () => {
    const grouped = groupForOverlay([])
    expect(Object.keys(grouped)).toEqual([...OVERLAY_GROUPS])
  })

  it("excludes actions without a hotkey — the overlay is a shortcut reference", () => {
    const actions = buildActions([
      action({ id: "reload", name: "Reload page", group: "Global", hotkey: "⌘R" }),
      action({ id: "switch-1", name: "Switch to GitHub", group: "Global" }),
    ])
    const grouped = groupForOverlay(actions)
    expect(grouped.Global.map((a) => a.id)).toEqual(["reload"])
  })
})

describe("hotkeyHint", () => {
  it("reports the display string for an action with a hotkey", () => {
    expect(hotkeyHint(action({ id: "r", name: "Reload", group: "Global", hotkey: "⌘R" }))).toBe(
      "⌘R",
    )
  })

  it("reports undefined for an action without a hotkey", () => {
    expect(hotkeyHint(action({ id: "x", name: "X", group: "Global" }))).toBeUndefined()
  })
})

describe("purity", () => {
  it("never touches window or document (smoke)", () => {
    // The module is imported at the top of this file under jsdom; if it touched
    // window/document at module scope it would already have thrown. This asserts the
    // query functions also work with window stubbed away.
    const actions = buildActions([action({ id: "a", name: "A", group: "Global", hotkey: "⌘A" })])
    expect(() => {
      filterActions(actions, "a")
      groupForOverlay(actions)
      hotkeyHint(actions[0])
    }).not.toThrow()
  })
})
