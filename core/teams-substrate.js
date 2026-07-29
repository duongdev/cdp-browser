// Pure helpers for Microsoft Teams Substrate Search (PSN-115, WS-A). The effectful part — running
// the authenticated fetch IN-PAGE via the CDP side-channel — lives in web/server.mjs's
// `/internal/teams/search`; this is the I/O-free request builder + response parser, so the body
// shape, the header mask, and the hit → `{convId,msgId,preview,sender,ts}` mapping stay unit-
// testable without a live Teams tab.
//
// Live-verified 2026-07-28 against a real tenant: POST {SUBSTRATE_URL} with `ContentSources:
// ["Exchange","Teams"]` returns real `IPM.SkypeTeams.Message` chat hits. `"Teams"` is load-bearing
// — without it the response contains only mail `IPM.Note`. Hit `ClientThreadId` is our `convId`
// (`19:…@thread.tacv2`); `ClientConversationId` carries `;messageid=<nativeMsgId>`, parsed here.
//
// Mirrors the style of sibling pure modules (teams-creds.js / teams-cursor.js); deliberately NOT a
// generic search client — the substrate schema is Teams-specific.

const SUBSTRATE_URL = "https://substrate.office.com/search/api/v2/query"

const DEFAULT_FIELDS = [
  "ItemClass",
  "Preview",
  "ClientConversationId",
  "ClientThreadId",
  "FromDisplayName",
  "DateTimeReceived",
  "Subject",
]

/**
 * Build the exact fetch args (url, method, headers, body) for a Substrate Search POST.
 *
 * `Authorization` is a PLACEHOLDER (`"Bearer <token>"`) — the in-page script replaces it with the
 * real bearer from the Teams tab's MSAL cache. Keeping the mask here makes the pure builder the
 * single owner of the header SET, so the route can't drift.
 *
 * `cvid` (client-request-id) is taken as a param so the module stays pure (no crypto.randomUUID
 * I/O); the route generates it and passes it in.
 */
function buildSubstrateQuery({ query, upn, cvid, from = 0, size = 25, fields = DEFAULT_FIELDS }) {
  const q = String(query ?? "")
  return {
    url: SUBSTRATE_URL,
    method: "POST",
    headers: {
      Authorization: "Bearer <token>",
      "X-AnchorMailbox": upn,
      "X-RoutingParameter-SessionKey": upn,
      "client-request-id": cvid,
      "Content-Type": "application/json",
    },
    body: {
      EntityRequests: [
        {
          EntityType: "Message",
          ContentSources: ["Exchange", "Teams"],
          Query: { QueryString: q, DisplayQueryString: q },
          From: from,
          Size: size,
          Fields: fields,
        },
      ],
      Cvid: cvid,
      Scenario: { Name: "msai.teams" },
      TimeZone: "UTC",
    },
  }
}

// Pull `<nativeMsgId>` out of `19:…@thread.tacv2;messageid=17852195988`. Returns "" when there's no
// `messageid=` segment — the caller drops a hit that has none (we can't address a single message).
const MESSAGE_ID_RE = /(?:^|;)messageid=([^;]+)/i

/** One Teams Substrate hit mapped to the shape the hydrate pipeline + search route consume. */
/**
 * @typedef {Object} SubstrateHit
 * @property {string} convId
 * @property {string} msgId
 * @property {string} preview
 * @property {string} sender
 * @property {number} ts
 * @property {string} subject
 * @property {string} itemClass
 */

/**
 * Parse a raw substrate response into `{ hits, total }`. Defensive throughout: a malformed Result
 * element is dropped, never thrown. Hits whose `ItemClass` isn't `IPM.SkypeTeams.Message` are
 * dropped (keeps Teams messages, sheds email IPM.Note even if ContentSources lied). A hit without a
 * `messageid=` segment is dropped — we can't address a single message without it.
 *
 * @param {Record<string, unknown> | null | undefined} json
 * @returns {{ hits: SubstrateHit[], total: number }}
 */
function parseSubstrateHits(json) {
  if (!json || typeof json !== "object") return { hits: [], total: 0 }
  const results = Array.isArray(/** @type {any} */ (json).Results) ? json.Results : []
  /** @type {SubstrateHit[]} */
  const hits = []
  for (const r of results) {
    const hit = mapOneHit(r)
    if (hit) hits.push(hit)
  }
  return { hits, total: hits.length }
}

// Map one Result element → SubstrateHit, or null if it should be dropped (non-Teams ItemClass,
// missing messageid, malformed shape). Fully defensive: never throws.
function mapOneHit(result) {
  if (!result || typeof result !== "object") return null
  const src = result.Source
  if (!src || typeof src !== "object") return null
  const itemClass = typeof src.ItemClass === "string" ? src.ItemClass : ""
  if (itemClass !== "IPM.SkypeTeams.Message") return null
  const convId = typeof src.ClientThreadId === "string" ? src.ClientThreadId : ""
  const cci = typeof src.ClientConversationId === "string" ? src.ClientConversationId : ""
  const match = MESSAGE_ID_RE.exec(cci)
  if (!match) return null // no messageid → can't address a single message
  const msgId = match[1]
  if (!convId || !msgId) return null
  const ts = parseTs(src.DateTimeReceived)
  return {
    convId,
    msgId,
    preview: typeof src.Preview === "string" ? src.Preview : "",
    sender: resolveSender(src),
    ts,
    subject: typeof src.Subject === "string" ? src.Subject : "",
    itemClass,
  }
}

// DateTimeReceived is ISO 8601 in the live payload. Date.parse → epoch ms, or NaN if missing/garbled
// (the route can drop or keep the hit — NaN compares falsey against any ts threshold).
function parseTs(v) {
  if (typeof v !== "string" || !v) return Number.NaN
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : Number.NaN
}

// FromDisplayName is the cheap path; From is a JSON-string-or-object with .EmailAddress.Name. Try
// both; fall back to "" so the caller never sees undefined.
function resolveSender(src) {
  if (typeof src.FromDisplayName === "string" && src.FromDisplayName) return src.FromDisplayName
  const from = src.From
  if (from == null) return ""
  let obj = from
  if (typeof from === "string") {
    try {
      obj = JSON.parse(from)
    } catch {
      return ""
    }
  }
  const name = obj?.EmailAddress?.Name
  return typeof name === "string" ? name : ""
}

/**
 * Map a substrate HTTP failure to a typed provider error code the routes surface unchanged.
 * 401 → `auth` (the route may silent-acquire once before surfacing); 429 → `rate_limited`;
 * anything else → `upstream_error`.
 */
function mapHttpError(status) {
  if (status === 401) return "auth"
  if (status === 429) return "rate_limited"
  return "upstream_error"
}

module.exports = {
  SUBSTRATE_URL,
  DEFAULT_FIELDS,
  buildSubstrateQuery,
  parseSubstrateHits,
  mapHttpError,
}
