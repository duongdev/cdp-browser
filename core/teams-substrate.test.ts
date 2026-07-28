import { describe, expect, it } from "vitest"
// Pure substrate-search request builder + response parser (PSN-115, WS-A). The effectful in-page
// fetch lives in web/server.mjs's `/internal/teams/search`; this is the I/O-free seam so the body
// shape, header mask and hit mapping stay unit-testable without a live Teams tab.
import {
  buildSubstrateQuery,
  mapHttpError,
  parseSubstrateHits,
  SUBSTRATE_URL,
  type SubstrateHit,
} from "./teams-substrate"

describe("buildSubstrateQuery", () => {
  it("builds the POST request with required headers and the Teams load-bearing ContentSources", () => {
    const cvid = "11111111-1111-1111-1111-111111111111"
    const out = buildSubstrateQuery({ query: "standup notes", upn: "me@contoso.com", cvid })

    expect(out.url).toBe(SUBSTRATE_URL)
    expect(out.method).toBe("POST")
    expect(out.headers["Content-Type"]).toBe("application/json")
    expect(out.headers["X-AnchorMailbox"]).toBe("me@contoso.com")
    expect(out.headers["X-RoutingParameter-SessionKey"]).toBe("me@contoso.com")
    expect(out.headers["client-request-id"]).toBe(cvid)
    // Authorization is a PLACEHOLDER here — the in-page script swaps in the real bearer. The field
    // must exist so the pure builder is the single owner of the header MASK.
    expect(out.headers.Authorization).toBe("Bearer <token>")
    expect(out.body.Cvid).toBe(cvid)
    expect(out.body.Scenario).toEqual({ Name: "msai.teams" })
    expect(out.body.TimeZone).toBe("UTC")
    const req = out.body.EntityRequests[0]
    expect(req.EntityType).toBe("Message")
    // "Teams" is load-bearing — without it the response only contains mail IPM.Note.
    expect(req.ContentSources).toEqual(["Exchange", "Teams"])
    expect(req.Query).toEqual({ QueryString: "standup notes", DisplayQueryString: "standup notes" })
    expect(req.From).toBe(0)
    expect(req.Size).toBe(25)
  })

  it("echoes the query into both Query and DisplayQueryString", () => {
    const out = buildSubstrateQuery({ query: "from:bob deploy", upn: "x@y.com", cvid: "c" })
    expect(out.body.EntityRequests[0].Query).toEqual({
      QueryString: "from:bob deploy",
      DisplayQueryString: "from:bob deploy",
    })
  })

  it("honours from/size overrides", () => {
    const out = buildSubstrateQuery({
      query: "q",
      upn: "x@y.com",
      cvid: "c",
      from: 50,
      size: 10,
    })
    expect(out.body.EntityRequests[0].From).toBe(50)
    expect(out.body.EntityRequests[0].Size).toBe(10)
  })

  it("forwards a custom field list when provided", () => {
    const fields = ["ItemClass", "Preview"]
    const out = buildSubstrateQuery({ query: "q", upn: "x@y.com", cvid: "c", fields })
    expect(out.body.EntityRequests[0].Fields).toBe(fields)
  })

  it("ignores sort/size/from when they are the defaults (sort is not on the body — it's a header-side concern for now)", () => {
    const out = buildSubstrateQuery({ query: "q", upn: "x@y.com", cvid: "c" })
    // Sortable has no body-side key in the live-verified shape; it's reserved for the route to add
    // later when we wire SortOrderSource. Asserting absence keeps the body minimal.
    expect(out.body).not.toHaveProperty("Sortable")
  })
})

describe("parseSubstrateHits", () => {
  it("maps a real Teams hit to {convId,msgId,preview,sender,ts,subject,itemClass}", () => {
    const json = {
      Results: [
        {
          Source: {
            ClientThreadId: "19:abc@thread.tacv2",
            ClientConversationId: "19:abc@thread.tacv2;messageid=17852195988",
            Preview: "deploy is green",
            FromDisplayName: "Bob Builder",
            DateTimeReceived: "2026-07-28T10:11:12.000Z",
            Subject: "Deploy",
            ItemClass: "IPM.SkypeTeams.Message",
          },
        },
      ],
    }
    const { hits, total } = parseSubstrateHits(json)
    expect(total).toBe(1)
    expect(hits).toHaveLength(1)
    const h: SubstrateHit = hits[0]
    expect(h.convId).toBe("19:abc@thread.tacv2")
    expect(h.msgId).toBe("17852195988")
    expect(h.preview).toBe("deploy is green")
    expect(h.sender).toBe("Bob Builder")
    expect(h.ts).toBe(Date.parse("2026-07-28T10:11:12.000Z"))
    expect(h.subject).toBe("Deploy")
    expect(h.itemClass).toBe("IPM.SkypeTeams.Message")
  })

  it("drops a hit whose ClientConversationId has no messageid= segment", () => {
    const json = {
      Results: [
        {
          Source: {
            ClientThreadId: "19:abc@thread.tacv2",
            // No messageid portion — can't address a single message; drop it.
            ClientConversationId: "19:abc@thread.tacv2",
            Preview: "orphan",
            ItemClass: "IPM.SkypeTeams.Message",
          },
        },
      ],
    }
    expect(parseSubstrateHits(json).hits).toEqual([])
  })

  it("drops non-Teams hit classes (email IPM.Note) defensively, even if ContentSources lied", () => {
    const json = {
      Results: [
        {
          Source: {
            ClientThreadId: "19:abc@thread.tacv2",
            ClientConversationId: "19:abc@thread.tacv2;messageid=1",
            Preview: "teams one",
            ItemClass: "IPM.SkypeTeams.Message",
          },
        },
        {
          Source: {
            ClientThreadId: "nope",
            ClientConversationId: "nope;messageid=2",
            Preview: "email one",
            ItemClass: "IPM.Note",
          },
        },
      ],
    }
    const { hits } = parseSubstrateHits(json)
    expect(hits.map((h) => h.msgId)).toEqual(["1"])
  })

  it("falls back to From.EmailAddress.Name when FromDisplayName is missing", () => {
    const json = {
      Results: [
        {
          Source: {
            ClientThreadId: "19:abc@thread.tacv2",
            ClientConversationId: "19:abc@thread.tacv2;messageid=99",
            Preview: "hi",
            From: { EmailAddress: { Name: "Alice Only" } },
            DateTimeReceived: "2026-01-01T00:00:00.000Z",
            ItemClass: "IPM.SkypeTeams.Message",
          },
        },
      ],
    }
    expect(parseSubstrateHits(json).hits[0].sender).toBe("Alice Only")
  })

  it("handles a string-valued From (some payloads inline a JSON string)", () => {
    const json = {
      Results: [
        {
          Source: {
            ClientThreadId: "19:abc@thread.tacv2",
            ClientConversationId: "19:abc@thread.tacv2;messageid=5",
            Preview: "hi",
            From: JSON.stringify({ EmailAddress: { Name: "Stringified Sender" } }),
            DateTimeReceived: "2026-01-01T00:00:00.000Z",
            ItemClass: "IPM.SkypeTeams.Message",
          },
        },
      ],
    }
    expect(parseSubstrateHits(json).hits[0].sender).toBe("Stringified Sender")
  })

  it("returns [] for missing/empty Results without throwing", () => {
    expect(parseSubstrateHits({})).toEqual({ hits: [], total: 0 })
    expect(parseSubstrateHits({ Results: [] })).toEqual({ hits: [], total: 0 })
    expect(parseSubstrateHits(null as unknown as Record<string, unknown>)).toEqual({
      hits: [],
      total: 0,
    })
  })

  it("skips a malformed Result element without throwing the whole batch", () => {
    const json = {
      Results: [
        null, // malformed entry
        {
          Source: {
            ClientThreadId: "19:abc@thread.tacv2",
            ClientConversationId: "19:abc@thread.tacv2;messageid=7",
            Preview: "good",
            DateTimeReceived: "2026-01-01T00:00:00.000Z",
            ItemClass: "IPM.SkypeTeams.Message",
          },
        },
      ],
    }
    const { hits, total } = parseSubstrateHits(json)
    expect(total).toBe(1)
    expect(hits[0].msgId).toBe("7")
  })

  it("tolerates a missing DateTimeReceived (ts falls back to NaN; the route can drop or keep it)", () => {
    const json = {
      Results: [
        {
          Source: {
            ClientThreadId: "19:abc@thread.tacv2",
            ClientConversationId: "19:abc@thread.tacv2;messageid=8",
            Preview: "notime",
            ItemClass: "IPM.SkypeTeams.Message",
          },
        },
      ],
    }
    const h = parseSubstrateHits(json).hits[0]
    expect(Number.isNaN(h.ts)).toBe(true)
  })
})

describe("mapHttpError", () => {
  it("maps 401 → auth", () => {
    expect(mapHttpError(401)).toBe("auth")
  })
  it("maps 429 → rate_limited", () => {
    expect(mapHttpError(429)).toBe("rate_limited")
  })
  it("maps any other status to upstream_error", () => {
    expect(mapHttpError(500)).toBe("upstream_error")
    expect(mapHttpError(404)).toBe("upstream_error")
    expect(mapHttpError(0)).toBe("upstream_error")
  })
})
