// Pure helpers for Microsoft Teams messaging-credential extraction (t127, ADR-0019).
// The effectful part — running Runtime.evaluate over the side-channel to dump the MSAL
// entries and mint the skype token in-page — lives in notifications-sidechain.js; these are
// the I/O-free parsers + the fresh/stale state machine, so they're unit-testable without a
// CDP socket. Deliberately a PARALLEL impl of slack-creds.js, not a shared generic: the
// mint chains differ (Slack scrapes a static session token; Teams reads a ~1h MSAL bearer
// then authz-mints a skype token). Secrets are never logged in full (see `redact`).

// MSAL caches Teams access tokens per audience; the one we want is scoped to the messaging
// audience `api.spaces.skype.com` — that entry's `.secret` is the bearer the authz endpoint
// exchanges for a skype token.
const SKYPE_AUDIENCE = "api.spaces.skype.com"

// Seconds of headroom required on a cached token. A token expiring inside this window is treated
// as already dead — it would very likely lapse mid-request (the AMS upload is a create + a PUT).
const TOKEN_SKEW_SECONDS = 60

// MSAL can hold SEVERAL accesstoken entries for the same audience, because the scope strings it
// keys them by normalize differently — a stray double slash (`ic3.teams.office.com//.default` vs
// `ic3.teams.office.com/.default`) is enough to mint a second, separate cache row. Teams only ever
// refreshes the row its live code asks for, so the sibling rots in place. Picking a match by key
// order therefore picks a dead token roughly at random, which is exactly what silently broke the
// image/attachment upload (PSN-121): the AMS scan took the LAST ic3 match, that was the rotted
// double-slash row, AMS answered 401, and the retry re-minted the skypetoken (a different
// credential) and re-read the same dead row. So: never pick by position — skip anything already
// expired and take the freshest survivor.
function pickFreshestEntry(entries, nowSeconds) {
  const now = Number.isFinite(nowSeconds) ? nowSeconds : Math.floor(Date.now() / 1000)
  let best = null
  for (const candidate of entries) {
    if (!candidate?.entry?.secret) continue
    const exp = Number(candidate.entry.expiresOn)
    // Only drop an entry we KNOW is spent; a missing/garbage expiresOn stays usable but ranks last.
    if (Number.isFinite(exp) && exp <= now + TOKEN_SKEW_SECONDS) continue
    const rank = Number.isFinite(exp) ? exp : 0
    if (!best || rank > best.rank) best = { ...candidate, rank }
  }
  return best ? { key: best.key, entry: best.entry } : null
}

// In-page source defining `__msalToken(match)` — the browser-side twin of `pickFreshestEntry`, for
// the CA-proof scripts that read the page's own MSAL cache over `Runtime.evaluate`. Injected as a
// string because it runs inside the remote Teams tab and can't import anything. `match(key, entry)`
// selects the audience; the return is `{ key, entry }` (so a caller can also read `entry.target`)
// or null when nothing live matches. Keep in step with `pickFreshestEntry` above.
const MSAL_TOKEN_READER_JS = `
  function __msalToken(match) {
    var now = Math.floor(Date.now() / 1000), best = null
    for (var keys = Object.keys(localStorage), i = 0; i < keys.length; i++) {
      var k = keys[i]
      if (k.indexOf("msal.") !== 0 || k.indexOf("accesstoken") < 0) continue
      var entry = null
      try { entry = JSON.parse(localStorage.getItem(k)) } catch (e) { continue }
      if (!entry || !entry.secret) continue
      if (!match(k, entry)) continue
      var exp = Number(entry.expiresOn)
      if (isFinite(exp) && exp <= now + ${TOKEN_SKEW_SECONDS}) continue
      var rank = isFinite(exp) ? exp : 0
      if (!best || rank > best.rank) best = { key: k, entry: entry, rank: rank }
    }
    return best ? { key: best.key, entry: best.entry } : null
  }
`

// Find the messaging-audience access token in a snapshot of the page's MSAL localStorage
// entries ({ key: rawJsonValue }). MSAL keys look like
// `msal.<accountId>-<env>-accesstoken-<clientId>-<tenant>-<scope…>`; the entry we want is
// the accesstoken whose scope targets `api.spaces.skype.com`. Returns { bearer, bearerExp }
// from the entry's `.secret` (the bearer JWT) + `.expiresOn` (epoch secs), or null when no
// such entry exists / is malformed. Duplicate rows are resolved by `pickFreshestEntry`, so an
// expired sibling can never shadow the live token. Defensive: bad input yields null, never throws.
function parseMsalBearer(snapshot, nowSeconds) {
  if (!snapshot || typeof snapshot !== "object") return null
  const candidates = []
  for (const key of Object.keys(snapshot)) {
    if (!key.startsWith("msal.")) continue
    if (!key.includes("accesstoken")) continue
    if (!key.toLowerCase().includes(SKYPE_AUDIENCE)) continue
    let entry
    try {
      entry = JSON.parse(snapshot[key])
    } catch {
      continue // a mangled entry shouldn't shadow a valid sibling
    }
    if (!Number.isFinite(Number(entry?.expiresOn))) continue
    candidates.push({ key, entry })
  }
  const best = pickFreshestEntry(candidates, nowSeconds)
  if (!best) return null
  return { bearer: String(best.entry.secret), bearerExp: Number(best.entry.expiresOn) }
}

// Decode a JWT's payload (the middle segment) to its claims object. Used to derive the AAD
// `tid` (tenant) + `oid` (user object id) from the bearer without a network round-trip.
// Signature is never verified here — the token came straight from the page's own MSAL cache,
// and we only read non-authoritative routing claims. Returns {} on any malformed input.
function decodeJwtClaims(jwt) {
  try {
    const payload = String(jwt).split(".")[1]
    if (!payload) return {}
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) || {}
  } catch {
    return {}
  }
}

// Record the tenant's creds as fresh and clear any prior auth error.
function markFresh(record, creds) {
  return { ...(record || {}), ...creds, fresh: true, lastError: null }
}

// Flag a tenant's creds stale (e.g. after a 401 on the msg service) while keeping the last
// creds so a re-mint can replace them. A stale Teams bearer only rotates via the live tab's
// MSAL, so the keeper tab is load-bearing — re-extraction re-reads + re-authz's.
function markStale(record, reason) {
  return { ...(record || {}), fresh: false, lastError: reason || "stale" }
}

// Short, length-tagged preview of a secret for logs — never the full bearer/skypeToken.
function redact(secret) {
  if (!secret) return "(empty)"
  const s = String(secret)
  return `${s.slice(0, 6)}…(${s.length} chars)`
}

module.exports = {
  SKYPE_AUDIENCE,
  TOKEN_SKEW_SECONDS,
  MSAL_TOKEN_READER_JS,
  pickFreshestEntry,
  parseMsalBearer,
  decodeJwtClaims,
  markFresh,
  markStale,
  redact,
}
