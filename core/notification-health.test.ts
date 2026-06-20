import { describe, expect, it } from "vitest"
import { buildHealth, shouldAlert, statusFor } from "./notification-health"

describe("statusFor", () => {
  it("is unsupported when the sweep is permanently blocked", () => {
    expect(statusFor({ sweepUnsupported: "team_is_restricted", fresh: true })).toBe("unsupported")
  })
  it("is degraded when creds are stale", () => {
    expect(statusFor({ fresh: false })).toBe("degraded")
  })
  it("is healthy with fresh creds and no restriction", () => {
    expect(statusFor({ fresh: true })).toBe("healthy")
    expect(statusFor({})).toBe("healthy") // fresh undefined → treated healthy
  })
})

describe("buildHealth", () => {
  const creds = [
    { teamId: "T1", name: "Acme", fresh: true, selfUserId: "U1" },
    { teamId: "T2", name: "BigCo", fresh: false, lastError: "invalid_auth" },
    { teamId: "T3", name: "Grid", fresh: true, sweepUnsupported: "team_is_restricted" },
  ]
  const meta = {
    T1: { seeded: true, lastSweepOk: 1000, lastEntryTs: 900 },
  }

  it("composes a row per workspace with the merged sweep metadata", () => {
    const rows = buildHealth(creds, meta)
    const t1 = rows.find((r) => r.teamId === "T1")
    expect(t1).toMatchObject({
      name: "Acme",
      status: "healthy",
      credsFresh: true,
      selfResolved: true,
      seeded: true,
      lastSweepOk: 1000,
      lastEntryTs: 900,
    })
  })

  it("surfaces the stale error and unsupported reason", () => {
    const rows = buildHealth(creds, meta)
    expect(rows.find((r) => r.teamId === "T2")).toMatchObject({
      status: "degraded",
      credsFresh: false,
      lastError: "invalid_auth",
    })
    expect(rows.find((r) => r.teamId === "T3")).toMatchObject({
      status: "unsupported",
      sweepUnsupported: true,
    })
  })

  it("sorts problems first (unsupported, degraded) then healthy by name", () => {
    const rows = buildHealth(creds, meta)
    expect(rows.map((r) => r.status)).toEqual(["unsupported", "degraded", "healthy"])
  })

  it("tolerates missing sweepMeta", () => {
    const rows = buildHealth(creds, undefined)
    expect(rows.find((r) => r.teamId === "T1")?.seeded).toBe(false)
  })
})

describe("buildHealth — Enterprise Grid grouping (t092)", () => {
  // Enterprise Grid live shape: org pseudo-team (client.counts, healthy) + restricted member workspace
  // (users.counts blocked → unsupported) + a standalone team.
  const creds = [
    {
      teamId: "E0EXAMPLE01",
      name: "Example Group Holdings Limited",
      enterpriseId: "",
      fresh: true,
      selfUserId: "U1",
    },
    {
      teamId: "T0EXAMPLE01",
      name: "Example Group",
      enterpriseId: "E0EXAMPLE01",
      fresh: true,
      sweepUnsupported: "team_is_restricted",
    },
    {
      teamId: "T0EXAMPLE02",
      name: "Example-Team",
      enterpriseId: "",
      fresh: true,
      selfUserId: "U3",
    },
  ]
  const meta = {
    E0EXAMPLE01: { seeded: true, lastSweepOk: 1000, lastEntryTs: 900 },
    T0EXAMPLE02: { seeded: true, lastSweepOk: 1100, lastEntryTs: 950 },
  }

  it("collapses the org + its member workspaces into one row, standalone stays separate", () => {
    const rows = buildHealth(creds, meta)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.groupId).sort()).toEqual(["E0EXAMPLE01", "T0EXAMPLE02"])
  })

  it("labels the merged row with the friendlier member name, not the org pseudo-team", () => {
    const rows = buildHealth(creds, meta)
    const fwd = rows.find((r) => r.groupId === "E0EXAMPLE01")
    expect(fwd?.name).toBe("Example Group")
  })

  it("reports the group healthy when ANY member sweeps via client.counts", () => {
    const rows = buildHealth(creds, meta)
    // The org member is healthy even though the restricted workspace alone is unsupported.
    expect(rows.find((r) => r.groupId === "E0EXAMPLE01")?.status).toBe("healthy")
  })

  it("carries the constituent teamIds + enterpriseId on the merged row", () => {
    const rows = buildHealth(creds, meta)
    const fwd = rows.find((r) => r.groupId === "E0EXAMPLE01")
    expect(fwd?.enterpriseId).toBe("E0EXAMPLE01")
    expect(fwd?.teamIds.sort()).toEqual(["E0EXAMPLE01", "T0EXAMPLE01"])
  })

  it("aggregates sweep meta across members (newest lastEntryTs / lastSweepOk)", () => {
    const rows = buildHealth(creds, meta)
    const fwd = rows.find((r) => r.groupId === "E0EXAMPLE01")
    expect(fwd?.seeded).toBe(true)
    expect(fwd?.lastSweepOk).toBe(1000)
    expect(fwd?.lastEntryTs).toBe(900)
  })

  it("a standalone team (no enterpriseId) is byte-unchanged: one row keyed by teamId", () => {
    const rows = buildHealth(creds, meta)
    const dcp = rows.find((r) => r.groupId === "T0EXAMPLE02")
    expect(dcp).toMatchObject({
      groupId: "T0EXAMPLE02",
      teamId: "T0EXAMPLE02",
      name: "Example-Team",
      status: "healthy",
      enterpriseId: "",
    })
    expect(dcp?.teamIds).toEqual(["T0EXAMPLE02"])
  })

  it("falls to degraded (not healthy) when no member sweeps but one has stale creds", () => {
    const rows = buildHealth(
      [
        {
          teamId: "Echild",
          name: "WS",
          enterpriseId: "EORG",
          fresh: false,
          lastError: "invalid_auth",
        },
        {
          teamId: "EORG",
          name: "Org",
          enterpriseId: "",
          fresh: true,
          sweepUnsupported: "team_is_restricted",
        },
      ],
      {},
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe("degraded")
  })

  it("keeps the concrete teamId of a representative member on the row for activation", () => {
    const rows = buildHealth(creds, meta)
    const fwd = rows.find((r) => r.groupId === "E0EXAMPLE01")
    // The teamId is one of the constituents (used as a fallback deep-link / display anchor).
    expect(fwd?.teamIds).toContain(fwd?.teamId)
  })
})

describe("shouldAlert — one-time degradation gate", () => {
  it("fires on first sight of a problem", () => {
    expect(shouldAlert(undefined, "degraded")).toBe(true)
    expect(shouldAlert(undefined, "unsupported")).toBe(true)
  })
  it("fires when crossing from healthy into a problem", () => {
    expect(shouldAlert("healthy", "degraded")).toBe(true)
  })
  it("does not re-fire while still in a problem state", () => {
    expect(shouldAlert("degraded", "degraded")).toBe(false)
    expect(shouldAlert("degraded", "unsupported")).toBe(false)
  })
  it("never fires for a healthy status", () => {
    expect(shouldAlert("degraded", "healthy")).toBe(false)
    expect(shouldAlert(undefined, "healthy")).toBe(false)
  })
})
