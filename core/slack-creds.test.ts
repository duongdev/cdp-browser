import { describe, expect, it } from "vitest"
// Pure helpers for Slack credential extraction (t069, ADR-0011).
import {
  buildSlackGroups,
  groupId,
  markFresh,
  markStale,
  parseLocalConfig,
  pickDCookie,
  redact,
} from "./slack-creds"

describe("parseLocalConfig — read xoxc tokens from localConfig_v2", () => {
  const raw = JSON.stringify({
    lastActiveTeamId: "T01",
    teams: {
      T01: { token: "xoxc-aaa", name: "Acme", url: "https://acme.slack.com/", enterprise_id: "" },
      E99: {
        token: "xoxc-bbb",
        name: "BigCo",
        url: "https://big.enterprise.slack.com/",
        enterprise_id: "",
      },
      TCHILD: {
        token: "xoxc-ccc",
        name: "BigCo WS",
        url: "https://bigws.slack.com/",
        enterprise_id: "E99",
      },
    },
  })

  it("returns lastActiveTeamId and a normalized team list", () => {
    const out = parseLocalConfig(raw)
    expect(out.lastActiveTeamId).toBe("T01")
    expect(out.teams).toHaveLength(3)
    const t01 = out.teams.find((t) => t.teamId === "T01")
    expect(t01).toEqual({
      teamId: "T01",
      token: "xoxc-aaa",
      name: "Acme",
      url: "https://acme.slack.com/",
      enterpriseId: "",
    })
  })

  it("carries enterprise_id for Enterprise Grid child workspaces", () => {
    const out = parseLocalConfig(raw)
    expect(out.teams.find((t) => t.teamId === "TCHILD")?.enterpriseId).toBe("E99")
  })

  it("returns an empty result for malformed / empty input", () => {
    expect(parseLocalConfig("not json")).toEqual({ lastActiveTeamId: null, teams: [] })
    expect(parseLocalConfig("{}")).toEqual({ lastActiveTeamId: null, teams: [] })
    expect(parseLocalConfig(undefined)).toEqual({ lastActiveTeamId: null, teams: [] })
  })

  it("skips teams that have no token", () => {
    const r = JSON.stringify({ teams: { T1: { name: "x" }, T2: { token: "xoxc-z", name: "y" } } })
    const out = parseLocalConfig(r)
    expect(out.teams.map((t) => t.teamId)).toEqual(["T2"])
  })
})

describe("pickDCookie — extract the d session cookie", () => {
  it("returns the value of the cookie named d", () => {
    expect(
      pickDCookie([
        { name: "lc", value: "x" },
        { name: "d", value: "xoxd-secret" },
      ]),
    ).toBe("xoxd-secret")
  })
  it("returns null when absent or input is bad", () => {
    expect(pickDCookie([{ name: "lc", value: "x" }])).toBeNull()
    expect(pickDCookie([])).toBeNull()
    expect(pickDCookie(undefined)).toBeNull()
  })
})

describe("cred state machine — fresh/stale transitions", () => {
  it("markFresh records creds and clears the error", () => {
    const rec = markFresh(
      { fresh: false, lastError: "invalid_auth" },
      {
        token: "xoxc-1",
        cookie: "xoxd-1",
        selfUserId: "U1",
      },
    )
    expect(rec).toMatchObject({
      fresh: true,
      token: "xoxc-1",
      cookie: "xoxd-1",
      selfUserId: "U1",
      lastError: null,
    })
  })

  it("markStale flips fresh to false and records the reason but keeps the last creds", () => {
    const rec = markStale(
      { fresh: true, token: "xoxc-1", cookie: "xoxd-1", selfUserId: "U1" },
      "invalid_auth",
    )
    expect(rec).toMatchObject({
      fresh: false,
      lastError: "invalid_auth",
      token: "xoxc-1", // retained so a later success can compare / re-use
    })
  })
})

describe("groupId — collapse an Enterprise Grid org + its workspaces (t092)", () => {
  it("returns enterpriseId when present (a Grid child workspace)", () => {
    expect(groupId({ teamId: "TGFUQ89E1", enterpriseId: "E0761H36LHY" })).toBe("E0761H36LHY")
  })

  it("returns teamId when enterpriseId is absent/empty (standalone or the org pseudo-team)", () => {
    expect(groupId({ teamId: "T01CDUT3CBD", enterpriseId: "" })).toBe("T01CDUT3CBD")
    expect(groupId({ teamId: "E0761H36LHY", enterpriseId: null })).toBe("E0761H36LHY")
    expect(groupId({ teamId: "T01CDUT3CBD" })).toBe("T01CDUT3CBD")
  })
})

describe("buildSlackGroups — teamId → groupId map (t092)", () => {
  it("maps every member workspace + the org pseudo-team to one groupId", () => {
    const map = buildSlackGroups([
      { teamId: "E0761H36LHY", enterpriseId: "" }, // the org pseudo-team
      { teamId: "TGFUQ89E1", enterpriseId: "E0761H36LHY" }, // member workspace
      { teamId: "T01CDUT3CBD", enterpriseId: "" }, // standalone
    ])
    expect(map).toEqual({
      E0761H36LHY: "E0761H36LHY",
      TGFUQ89E1: "E0761H36LHY",
      T01CDUT3CBD: "T01CDUT3CBD",
    })
  })

  it("returns an empty map for no creds", () => {
    expect(buildSlackGroups([])).toEqual({})
    expect(buildSlackGroups(undefined)).toEqual({})
  })

  it("ignores creds with no teamId", () => {
    expect(buildSlackGroups([{ teamId: "", enterpriseId: "E1" }])).toEqual({})
  })
})

describe("redact — never log secrets in full", () => {
  it("shows a short prefix + length, not the secret", () => {
    const r = redact("xoxc-1234567890abcdef")
    expect(r).toContain("xoxc-")
    expect(r).not.toContain("7890abcdef")
    expect(r).toMatch(/\d+ chars/)
  })
  it("handles empty / nullish input", () => {
    expect(redact("")).toBe("(empty)")
    expect(redact(null)).toBe("(empty)")
  })
})
