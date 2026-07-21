import { describe, expect, it } from "vitest"
// Pure helpers for Teams messaging-credential extraction (t105, ADR-0018).
import { decodeJwtClaims, markFresh, markStale, parseMsalBearer, redact } from "./teams-creds"

// Build a fake unsigned JWT with the given claims payload (signature is never verified).
const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url")
const fakeJwt = (claims: Record<string, unknown>) =>
  `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims)}.sig`

describe("parseMsalBearer — find the api.spaces.skype.com access token", () => {
  const bearer = fakeJwt({ tid: "TENANT-1", oid: "USER-1" })
  // A realistic MSAL localStorage snapshot: one Graph-audience token, one messaging-audience
  // token. Only the messaging one (api.spaces.skype.com) should be picked.
  const snapshot = {
    "msal.account.keys": '["home-account-id"]',
    // A same-client accesstoken for the Graph audience — excluded purely by audience.
    "msal.home-account-id-login.windows.net-accesstoken-5e3ce6c0-tenant-graph.microsoft.com--":
      JSON.stringify({ secret: "graph-bearer", expiresOn: "1111" }),
    "msal.token.keys.5e3ce6c0": '{"accessToken":[]}',
    "msal.home-account-id-login.windows.net-accesstoken-5e3ce6c0-tenant-https://api.spaces.skype.com/user_impersonation--":
      JSON.stringify({ secret: bearer, expiresOn: "1750000000" }),
  }

  it("returns the skype-audience bearer + parsed expiry, ignoring other-audience entries", () => {
    expect(parseMsalBearer(snapshot)).toEqual({ bearer, bearerExp: 1750000000 })
  })

  it("returns null when no skype-audience accesstoken entry exists", () => {
    const onlyGraph = {
      "msal.home-account-id-login.windows.net-accesstoken-5e3ce6c0-tenant-graph.microsoft.com--":
        JSON.stringify({ secret: "graph-bearer", expiresOn: "1111" }),
    }
    expect(parseMsalBearer(onlyGraph)).toBeNull()
  })

  it("returns null on malformed JSON / missing secret / bad input", () => {
    const key =
      "msal.acc-login.windows.net-accesstoken-5e3ce6c0-tenant-https://api.spaces.skype.com/x--"
    expect(parseMsalBearer({ [key]: "not json" })).toBeNull()
    expect(parseMsalBearer({ [key]: JSON.stringify({ expiresOn: "1" }) })).toBeNull()
    expect(parseMsalBearer(null)).toBeNull()
    expect(parseMsalBearer("nope")).toBeNull()
    expect(parseMsalBearer({})).toBeNull()
  })
})

describe("decodeJwtClaims — derive tenant/user from the bearer", () => {
  it("decodes the tid/oid claims from the payload segment", () => {
    const jwt = fakeJwt({ tid: "T-99", oid: "O-42", aud: "api.spaces.skype.com" })
    const claims = decodeJwtClaims(jwt)
    expect(claims.tid).toBe("T-99")
    expect(claims.oid).toBe("O-42")
  })

  it("returns {} on malformed / non-JWT input", () => {
    expect(decodeJwtClaims("garbage")).toEqual({})
    expect(decodeJwtClaims("")).toEqual({})
    expect(decodeJwtClaims(null)).toEqual({})
  })
})

describe("cred state machine — fresh/stale transitions", () => {
  it("markFresh records creds and clears the error", () => {
    const rec = markFresh(
      { fresh: false, lastError: "invalid_auth" },
      { tenant: "T1", skypeToken: "skype-1", chatServiceBase: "https://apac.ng.msg" },
    )
    expect(rec).toMatchObject({
      fresh: true,
      tenant: "T1",
      skypeToken: "skype-1",
      chatServiceBase: "https://apac.ng.msg",
      lastError: null,
    })
  })

  it("markStale flips fresh to false and records the reason but keeps the last creds", () => {
    const rec = markStale({ fresh: true, tenant: "T1", skypeToken: "skype-1" }, "invalid_auth")
    expect(rec).toMatchObject({
      fresh: false,
      lastError: "invalid_auth",
      skypeToken: "skype-1", // retained so a re-mint can compare / re-use
    })
  })
})

describe("redact — never log the bearer / skypeToken in full", () => {
  it("shows a short prefix + length, not the secret", () => {
    const r = redact("skype-super-secret-token-abcdef")
    expect(r).toContain("skype-")
    expect(r).not.toContain("secret-token-abcdef")
    expect(r).toMatch(/\d+ chars/)
  })
  it("handles empty / nullish input", () => {
    expect(redact("")).toBe("(empty)")
    expect(redact(null)).toBe("(empty)")
  })
})
