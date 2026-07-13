import { describe, expect, it } from "vitest"
// Pure Slack workspace registry + parked-tab planner (t070, ADR-0011).
import {
  canonicalWorkspaceUrl,
  hasBrokenSlackSession,
  isTeamId,
  liveTeamIds,
  planParkedTabs,
  pruneRegistry,
  upsertWorkspace,
} from "./slack-workspaces"

const CLIENT = (team: string, ch = "C1") => `https://app.slack.com/client/${team}/${ch}`
const CANON = (team: string) => `https://app.slack.com/client/${team}`

describe("upsertWorkspace — register a workspace seen as its own tab", () => {
  it("adds a new workspace keyed by teamId with lastSeen", () => {
    const reg = upsertWorkspace({}, { teamId: "T1", name: "Acme" }, 1000)
    expect(reg.T1).toEqual({
      teamId: "T1",
      url: CANON("T1"),
      name: "Acme",
      enterpriseId: "",
      lastSeen: 1000,
    })
  })

  it("persists enterpriseId for an Enterprise Grid child (t092)", () => {
    const reg = upsertWorkspace(
      {},
      { teamId: "T0EXAMPLE01", name: "Example Group", enterpriseId: "E0EXAMPLE01" },
      1000,
    )
    expect(reg.T0EXAMPLE01.enterpriseId).toBe("E0EXAMPLE01")
  })

  it("stores the canonical workspace URL, never the observed one (t104)", () => {
    // The observed URL can carry a channel segment (noise) or a failure state
    // (`?sso_failed=1`) that would be faithfully reopened into the same failure forever.
    const reg = upsertWorkspace({}, { teamId: "T1", name: "Acme" }, 1000)
    expect(reg.T1.url).toBe(CANON("T1"))
  })

  it("updates lastSeen on a repeat sighting, preserving identity", () => {
    const a = upsertWorkspace({}, { teamId: "T1", name: "Acme" }, 1000)
    const b = upsertWorkspace(a, { teamId: "T1", name: "Acme" }, 2000)
    expect(b.T1.url).toBe(CANON("T1"))
    expect(b.T1.lastSeen).toBe(2000)
  })

  it("does not mutate the input registry", () => {
    const a = upsertWorkspace({}, { teamId: "T1", name: "A" }, 1000)
    const b = upsertWorkspace(a, { teamId: "T2", name: "B" }, 2000)
    expect(Object.keys(a)).toEqual(["T1"])
    expect(Object.keys(b).sort()).toEqual(["T1", "T2"])
  })

  it("ignores an entry with no resolvable teamId", () => {
    expect(upsertWorkspace({}, { teamId: "", name: "n" }, 1)).toEqual({})
  })

  it("rejects a phantom id that is not a real team id (t104)", () => {
    // Pre-t104 the Grid sign-in host `acme.enterprise.slack.com` parsed as team
    // "acme.enterprise" and got registered — a workspace with no creds, no sweep, and a
    // parked tab reopened forever.
    expect(upsertWorkspace({}, { teamId: "acme.enterprise", name: "" }, 1)).toEqual({})
    expect(upsertWorkspace({}, { teamId: "acme", name: "" }, 1)).toEqual({})
  })
})

describe("isTeamId / canonicalWorkspaceUrl", () => {
  it("accepts T… and E… ids only", () => {
    expect(isTeamId("T01CDUT3CBD")).toBe(true)
    expect(isTeamId("E0761H36LHY")).toBe(true)
    expect(isTeamId("acme.enterprise")).toBe(false)
    expect(isTeamId("acme")).toBe(false)
    expect(isTeamId("C01CSBTB8DP")).toBe(false)
    expect(isTeamId("")).toBe(false)
  })

  it("builds the channel-less, query-less client URL", () => {
    expect(canonicalWorkspaceUrl("T01CDUT3CBD")).toBe("https://app.slack.com/client/T01CDUT3CBD")
  })
})

describe("pruneRegistry — self-heal a poisoned registry on load (t104)", () => {
  it("drops a phantom key and canonicalizes a stale URL", () => {
    const poisoned = {
      "acme.enterprise": {
        teamId: "acme.enterprise",
        url: "https://acme.enterprise.slack.com/?sso_failed=1",
        name: "",
        lastSeen: 1,
      },
      T01CDUT3CBD: {
        teamId: "T01CDUT3CBD",
        url: CLIENT("T01CDUT3CBD", "C9"),
        name: "A",
        lastSeen: 2,
      },
    }
    expect(pruneRegistry(poisoned)).toEqual({
      T01CDUT3CBD: { teamId: "T01CDUT3CBD", url: CANON("T01CDUT3CBD"), name: "A", lastSeen: 2 },
    })
  })

  it("leaves a clean registry untouched", () => {
    const clean = {
      T1: { teamId: "T1", url: CANON("T1"), name: "", enterpriseId: "", lastSeen: 1 },
    }
    expect(pruneRegistry(clean)).toEqual(clean)
  })

  it("tolerates an empty or missing registry", () => {
    expect(pruneRegistry({})).toEqual({})
    expect(pruneRegistry(undefined as never)).toEqual({})
  })
})

describe("hasBrokenSlackSession — a sign-in landing page means the session is dead (t104)", () => {
  it("detects a slack.com page target with no resolvable team", () => {
    expect(
      hasBrokenSlackSession([
        { type: "page", url: CLIENT("T1") },
        { type: "page", url: "https://acme.enterprise.slack.com/?sso_failed=1" },
      ]),
    ).toBe(true)
  })

  it("is false when every Slack page is a real client tab", () => {
    expect(
      hasBrokenSlackSession([
        { type: "page", url: CLIENT("T1") },
        { type: "page", url: "https://example.com/" },
      ]),
    ).toBe(false)
  })

  it("ignores non-page targets (service workers live under app.slack.com too)", () => {
    expect(
      hasBrokenSlackSession([
        { type: "service_worker", url: "https://app.slack.com/service-worker.js" },
      ]),
    ).toBe(false)
  })

  it("is false with no Slack targets at all", () => {
    expect(hasBrokenSlackSession([{ type: "page", url: "https://example.com/" }])).toBe(false)
    expect(hasBrokenSlackSession([])).toBe(false)
  })

  it("does not match a lookalike host", () => {
    expect(hasBrokenSlackSession([{ type: "page", url: "https://slack.com.evil.com/x" }])).toBe(
      false,
    )
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

  it("omitting pinUrlByTeam is byte-identical to the prior behavior", () => {
    expect(planParkedTabs(reg, new Set(["T1"]), {}, 5000)).toEqual([
      { teamId: "T2", url: CLIENT("T2") },
    ])
  })
})

describe("planParkedTabs — defers to a pinned workspace (t098)", () => {
  const reg = {
    T1: { teamId: "T1", url: CLIENT("T1"), name: "A", lastSeen: 1 },
    T2: { teamId: "T2", url: CLIENT("T2"), name: "B", lastSeen: 1 },
  }
  const PIN = (team: string) => `https://app.slack.com/client/${team}/CPIN`

  it("skips a registered workspace that has a pin — the pin owns it", () => {
    // T1 live, T2 not live but pinned → no reopen for T2.
    const plans = planParkedTabs(reg, new Set(["T1"]), {}, 5000, { T2: PIN("T2") })
    expect(plans).toEqual([])
  })

  it("still plans an unpinned workspace alongside a pinned one", () => {
    // T1 pinned (skip), T2 unpinned + not live → only T2 reopens.
    const plans = planParkedTabs(reg, new Set(), {}, 5000, { T1: PIN("T1") })
    expect(plans).toEqual([{ teamId: "T2", url: CLIENT("T2") }])
  })

  it("cred lifeline: opens one pinned workspace (at the pin URL) when nothing is live and nothing else is planned", () => {
    // Both pinned, neither live → no normal plan, but the lifeline opens exactly one at its pin URL.
    const plans = planParkedTabs(reg, new Set(), {}, 5000, { T1: PIN("T1"), T2: PIN("T2") })
    expect(plans).toHaveLength(1)
    expect(plans[0]).toEqual({ teamId: "T1", url: PIN("T1") })
  })

  it("no lifeline when a Slack tab is already live", () => {
    const plans = planParkedTabs(reg, new Set(["T1"]), {}, 5000, { T1: PIN("T1"), T2: PIN("T2") })
    expect(plans).toEqual([])
  })

  it("no lifeline when an unpinned plan already keeps a tab alive", () => {
    // T1 pinned, T2 unpinned + not live → T2's normal plan covers cred-refresh; no extra lifeline.
    const plans = planParkedTabs(reg, new Set(), {}, 5000, { T1: PIN("T1") })
    expect(plans).toEqual([{ teamId: "T2", url: CLIENT("T2") }])
  })

  it("cred lifeline respects the create cooldown", () => {
    // Only T1 registered + pinned, not live, but just created at t=4000 (cooldown) → no lifeline.
    const oneReg = { T1: reg.T1 }
    const plans = planParkedTabs(oneReg, new Set(), { T1: 4000 }, 5000, { T1: PIN("T1") })
    expect(plans).toEqual([])
  })

  it("cred lifeline bootstraps from a pin even when the workspace is not yet registered", () => {
    // Fresh start: empty registry, no live tab, a pin exists → open it to seed creds.
    const plans = planParkedTabs({}, new Set(), {}, 5000, { T9: PIN("T9") })
    expect(plans).toEqual([{ teamId: "T9", url: PIN("T9") }])
  })
})

describe("planParkedTabs — stands down on a broken Slack session (t104)", () => {
  const reg = {
    T1: { teamId: "T1", url: CANON("T1"), name: "A", lastSeen: 1 },
    T2: { teamId: "T2", url: CANON("T2"), name: "B", lastSeen: 1 },
  }
  const PIN = (team: string) => `https://app.slack.com/client/${team}/CPIN`

  it("plans nothing when the session is broken — more tabs just redirect to sign-in", () => {
    expect(planParkedTabs(reg, new Set(), {}, 5000, {}, true)).toEqual([])
  })

  it("suppresses the cred lifeline too", () => {
    expect(planParkedTabs(reg, new Set(), {}, 5000, { T1: PIN("T1") }, true)).toEqual([])
  })

  it("resumes normal planning once the session is healthy again", () => {
    expect(planParkedTabs(reg, new Set(["T1"]), {}, 5000, {}, false)).toEqual([
      { teamId: "T2", url: CANON("T2") },
    ])
  })
})
