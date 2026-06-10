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
