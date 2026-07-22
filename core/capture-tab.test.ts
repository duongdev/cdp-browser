import { describe, expect, it } from "vitest"
// CommonJS module shared by path with any CDP backend (main.js today).
import { CAPTURE_MARKER, planCaptureTabs } from "./capture-tab"

const TEAMS = [{ name: "teams", url: "https://teams.microsoft.com/v2/" }]
// isMarked from a set of capture-tab ids
const marked =
  (...ids: string[]) =>
  (id: string) =>
    ids.includes(id)

describe("capture-tab planner", () => {
  it("exposes the durable window.name marker", () => {
    expect(CAPTURE_MARKER).toBe("__cdpCaptureTab")
  })

  it("opens a capture tab when a usable adapter tab exists but none is marked", () => {
    const tabs = [{ id: "A", adapter: "teams" }]
    expect(planCaptureTabs(tabs, marked(), TEAMS)).toEqual({
      create: [{ adapter: "teams", url: "https://teams.microsoft.com/v2/" }],
      reap: [],
    })
  })

  it("is a no-op when one usable tab and one capture tab already exist", () => {
    const tabs = [
      { id: "A", adapter: "teams" },
      { id: "CAP", adapter: "teams" },
    ]
    expect(planCaptureTabs(tabs, marked("CAP"), TEAMS)).toEqual({ create: [], reap: [] })
  })

  it("reaps extra capture tabs (multi-client race self-heals), keeping the first", () => {
    const tabs = [
      { id: "A", adapter: "teams" },
      { id: "CAP1", adapter: "teams" },
      { id: "CAP2", adapter: "teams" },
      { id: "CAP3", adapter: "teams" },
    ]
    expect(planCaptureTabs(tabs, marked("CAP1", "CAP2", "CAP3"), TEAMS)).toEqual({
      create: [],
      reap: ["CAP2", "CAP3"],
    })
  })

  it("reaps a lone capture tab when no usable adapter tab remains", () => {
    const tabs = [{ id: "CAP", adapter: "teams" }]
    expect(planCaptureTabs(tabs, marked("CAP"), TEAMS)).toEqual({ create: [], reap: ["CAP"] })
  })

  it("does nothing when the adapter has no tabs at all (never force-opens the app)", () => {
    expect(planCaptureTabs([], marked(), TEAMS)).toEqual({ create: [], reap: [] })
  })

  it("ignores adapters without a capture-tab config", () => {
    const tabs = [{ id: "S", adapter: "slack" }]
    expect(planCaptureTabs(tabs, marked(), TEAMS)).toEqual({ create: [], reap: [] })
  })

  it("plans per-adapter independently", () => {
    const tabs = [
      { id: "T", adapter: "teams" },
      { id: "O", adapter: "outlook" },
      { id: "OCAP", adapter: "outlook" },
    ]
    const adapters = [
      { name: "teams", url: "https://teams.microsoft.com/v2/" },
      { name: "outlook", url: "https://outlook.office.com/mail/" },
    ]
    expect(planCaptureTabs(tabs, marked("OCAP"), adapters)).toEqual({
      create: [{ adapter: "teams", url: "https://teams.microsoft.com/v2/" }],
      reap: [],
    })
  })
})
