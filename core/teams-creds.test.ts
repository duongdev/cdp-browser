import { describe, expect, it } from "vitest"
// Pure helpers for Teams messaging-credential extraction (t127, ADR-0019).
import {
  decodeJwtClaims,
  MSAL_TOKEN_READER_JS,
  markFresh,
  markStale,
  parseMsalBearer,
  pickFreshestEntry,
  redact,
} from "./teams-creds"

// Build a fake unsigned JWT with the given claims payload (signature is never verified).
const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url")
const fakeJwt = (claims: Record<string, unknown>) =>
  `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims)}.sig`

// A fixed "now" so expiry assertions never depend on the wall clock.
const NOW = 1_750_000_000
const LIVE = String(NOW + 3600)
const DEAD = String(NOW - 3600)

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
      JSON.stringify({ secret: bearer, expiresOn: LIVE }),
  }

  it("returns the skype-audience bearer + parsed expiry, ignoring other-audience entries", () => {
    expect(parseMsalBearer(snapshot, NOW)).toEqual({ bearer, bearerExp: Number(LIVE) })
  })

  it("returns null when no skype-audience accesstoken entry exists", () => {
    const onlyGraph = {
      "msal.home-account-id-login.windows.net-accesstoken-5e3ce6c0-tenant-graph.microsoft.com--":
        JSON.stringify({ secret: "graph-bearer", expiresOn: "1111" }),
    }
    expect(parseMsalBearer(onlyGraph, NOW)).toBeNull()
  })

  it("returns null on malformed JSON / missing secret / bad input", () => {
    const key =
      "msal.acc-login.windows.net-accesstoken-5e3ce6c0-tenant-https://api.spaces.skype.com/x--"
    expect(parseMsalBearer({ [key]: "not json" }, NOW)).toBeNull()
    expect(parseMsalBearer({ [key]: JSON.stringify({ expiresOn: "1" }) }, NOW)).toBeNull()
    expect(parseMsalBearer(null, NOW)).toBeNull()
    expect(parseMsalBearer("nope", NOW)).toBeNull()
    expect(parseMsalBearer({}, NOW)).toBeNull()
  })

  // PSN-121: MSAL keeps a second row per audience when the scope string normalizes differently
  // (a stray double slash), and Teams only refreshes the row its own code asks for.
  it("picks the live duplicate over an expired sibling regardless of key order", () => {
    const live = fakeJwt({ tid: "T", oid: "U" })
    const dupes = {
      "msal.acc-login.windows.net-accesstoken-c-t-https://api.spaces.skype.com/user_impersonation--":
        JSON.stringify({ secret: live, expiresOn: LIVE }),
      // Sorts after the live row, and is exactly the shape that broke the AMS upload.
      "msal.zzz-login.windows.net-accesstoken-c-t-https://api.spaces.skype.com//user_impersonation--":
        JSON.stringify({ secret: "rotted", expiresOn: DEAD }),
    }
    expect(parseMsalBearer(dupes, NOW)?.bearer).toBe(live)
  })

  it("returns null when every matching row is already expired", () => {
    const allDead = {
      "msal.acc-login.windows.net-accesstoken-c-t-https://api.spaces.skype.com/x--": JSON.stringify(
        {
          secret: "rotted",
          expiresOn: DEAD,
        },
      ),
    }
    expect(parseMsalBearer(allDead, NOW)).toBeNull()
  })
})

describe("pickFreshestEntry — resolve duplicate MSAL rows (PSN-121)", () => {
  const row = (secret: string, expiresOn: unknown) => ({
    key: secret,
    entry: { secret, expiresOn },
  })

  it("takes the entry with the furthest expiry", () => {
    const picked = pickFreshestEntry(
      [row("soon", NOW + 120), row("later", NOW + 7200), row("dead", NOW - 1)],
      NOW,
    )
    expect(picked?.entry.secret).toBe("later")
  })

  it("rejects a token inside the 60s skew window — it would lapse mid-request", () => {
    expect(pickFreshestEntry([row("edge", NOW + 30)], NOW)).toBeNull()
    expect(pickFreshestEntry([row("ok", NOW + 90)], NOW)?.entry.secret).toBe("ok")
  })

  it("keeps a row with an unreadable expiresOn but ranks it below any dated row", () => {
    expect(pickFreshestEntry([row("undated", "garbage")], NOW)?.entry.secret).toBe("undated")
    expect(
      pickFreshestEntry([row("undated", "garbage"), row("dated", NOW + 600)], NOW)?.entry.secret,
    ).toBe("dated")
  })

  it("ignores rows with no secret and returns null on an empty set", () => {
    expect(pickFreshestEntry([{ key: "k", entry: { expiresOn: NOW + 600 } }], NOW)).toBeNull()
    expect(pickFreshestEntry([], NOW)).toBeNull()
  })
})

// The in-page reader is a string injected into the remote Teams tab, so the only honest test is to
// actually run it against a fake localStorage — that keeps it provably in step with the host-side
// pickFreshestEntry instead of being a second, untested copy of the rule.
describe("MSAL_TOKEN_READER_JS — the in-page twin", () => {
  const evalReader = (store: Record<string, string>, nowMs: number) => {
    const localStorage = {
      getItem: (k: string) => (k in store ? store[k] : null),
      ...store,
    }
    const make = new Function(
      "localStorage",
      "Object",
      "Date",
      `${MSAL_TOKEN_READER_JS}; return __msalToken`,
    )
    return make(localStorage, { keys: () => Object.keys(store) }, { now: () => nowMs }) as (
      m: (k: string, e: { secret: string; expiresOn: unknown }) => boolean,
    ) => {
      key: string
      entry: { secret: string; expiresOn: unknown }
    } | null
  }

  const ic3 = (k: string) => k.includes("ic3.teams.office.com")

  it("picks the live ic3 row over the expired double-slash sibling that sorts after it", () => {
    const reader = evalReader(
      {
        "msal.a-accesstoken-c-t-https://ic3.teams.office.com/teams.accessasuser.all|":
          JSON.stringify({ secret: "live", expiresOn: NOW + 3000 }),
        "msal.z-accesstoken-c-t-https://ic3.teams.office.com//teams.accessasuser.all|":
          JSON.stringify({ secret: "rotted", expiresOn: NOW - 2500 }),
      },
      NOW * 1000,
    )
    expect(reader(ic3)?.entry.secret).toBe("live")
  })

  it("returns null when every ic3 row is spent, and skips non-accesstoken / unparsable rows", () => {
    expect(
      evalReader(
        {
          "msal.a-accesstoken-c-t-https://ic3.teams.office.com/x|": JSON.stringify({
            secret: "rotted",
            expiresOn: NOW - 10,
          }),
        },
        NOW * 1000,
      )(ic3),
    ).toBeNull()
    expect(
      evalReader(
        {
          "msal.account.keys": '["x"]',
          "msal.a-accesstoken-c-t-https://ic3.teams.office.com/x|": "not json",
          "other.key": JSON.stringify({ secret: "s", expiresOn: NOW + 999 }),
        },
        NOW * 1000,
      )(ic3),
    ).toBeNull()
  })

  it("exposes the matched entry so a caller can read its scope target", () => {
    const reader = evalReader(
      {
        "msal.a-accesstoken-c-t-sp|": JSON.stringify({
          secret: "sp-token",
          expiresOn: NOW + 900,
          target: "https://fwdgroup-my.sharepoint.com/MyFiles.Write",
        }),
      },
      NOW * 1000,
    )
    const hit = reader((_k, e) => /-my\.sharepoint\.com/.test(String(e.target || "")))
    expect(hit?.entry.target).toContain("fwdgroup-my.sharepoint.com")
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
