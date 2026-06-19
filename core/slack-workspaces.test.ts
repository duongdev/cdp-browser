import { describe, expect, it } from "vitest"
// Pure Slack workspace registry + parked-tab planner (t070, ADR-0011).
import { liveTeamIds, planParkedTabs, upsertWorkspace } from "./slack-workspaces"

const CLIENT = (team: string, ch = "C1") => `https://app.slack.com/client/${team}/${ch}`

describe("upsertWorkspace — register a workspace seen as its own tab", () => {
  it("adds a new workspace keyed by teamId with lastSeen", () => {
    const reg = upsertWorkspace({}, { teamId: "T1", url: CLIENT("T1"), name: "Acme" }, 1000)
    expect(reg.T1).toEqual({
      teamId: "T1",
      url: CLIENT("T1"),
      name: "Acme",
      enterpriseId: "",
      lastSeen: 1000,
    })
  })

  it("persists enterpriseId for an Enterprise Grid child (t092)", () => {
    const reg = upsertWorkspace(
      {},
      {
        teamId: "TGFUQ89E1",
        url: CLIENT("TGFUQ89E1"),
        name: "FWD Group",
        enterpriseId: "E0761H36LHY",
      },
      1000,
    )
    expect(reg.TGFUQ89E1.enterpriseId).toBe("E0761H36LHY")
  })

  it("updates url + lastSeen on a repeat sighting, preserving identity", () => {
    const a = upsertWorkspace({}, { teamId: "T1", url: CLIENT("T1", "C1"), name: "Acme" }, 1000)
    const b = upsertWorkspace(a, { teamId: "T1", url: CLIENT("T1", "C9"), name: "Acme" }, 2000)
    expect(b.T1.url).toBe(CLIENT("T1", "C9"))
    expect(b.T1.lastSeen).toBe(2000)
  })

  it("does not mutate the input registry", () => {
    const a = upsertWorkspace({}, { teamId: "T1", url: CLIENT("T1"), name: "A" }, 1000)
    const b = upsertWorkspace(a, { teamId: "T2", url: CLIENT("T2"), name: "B" }, 2000)
    expect(Object.keys(a)).toEqual(["T1"])
    expect(Object.keys(b).sort()).toEqual(["T1", "T2"])
  })

  it("ignores an entry with no resolvable teamId", () => {
    const a = upsertWorkspace({}, { teamId: "", url: "x", name: "n" }, 1)
    expect(a).toEqual({})
  })
})

describe("liveTeamIds — which workspaces have a live tab", () => {
  it("extracts team ids from slack client target urls", () => {
    const ids = liveTeamIds([
      { url: CLIENT("T1") },
      { url: CLIENT("E2", "C3") },
      { url: "https://example.com/" },
      { url: "https://app.slack.com/service-worker.js" },
    ])
    expect([...ids].sort()).toEqual(["E2", "T1"])
  })
})

describe("planParkedTabs — recreate registered workspaces with no live tab", () => {
  const reg = {
    T1: { teamId: "T1", url: CLIENT("T1"), name: "A", lastSeen: 1 },
    T2: { teamId: "T2", url: CLIENT("T2"), name: "B", lastSeen: 1 },
  }
  it("plans a tab for a registered workspace that is not live", () => {
    const plans = planParkedTabs(reg, new Set(["T1"]), {}, 5000)
    expect(plans).toEqual([{ teamId: "T2", url: CLIENT("T2") }])
  })
  it("plans nothing when every registered workspace is live", () => {
    expect(planParkedTabs(reg, new Set(["T1", "T2"]), {}, 5000)).toEqual([])
  })
  it("suppresses a workspace created recently (within the cooldown)", () => {
    // T2 not live, but was just created at t=4000; now=5000, cooldown=30000 → suppressed.
    const plans = planParkedTabs(reg, new Set(["T1"]), { T2: 4000 }, 5000)
    expect(plans).toEqual([])
  })
  it("re-plans a workspace whose cooldown has elapsed", () => {
    const plans = planParkedTabs(reg, new Set(["T1"]), { T2: 4000 }, 40000)
    expect(plans).toEqual([{ teamId: "T2", url: CLIENT("T2") }])
  })
})
