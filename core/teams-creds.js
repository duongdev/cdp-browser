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

// Find the messaging-audience access token in a snapshot of the page's MSAL localStorage
// entries ({ key: rawJsonValue }). MSAL keys look like
// `msal.<accountId>-<env>-accesstoken-<clientId>-<tenant>-<scope…>`; the entry we want is
// the accesstoken whose scope targets `api.spaces.skype.com`. Returns { bearer, bearerExp }
// from the entry's `.secret` (the bearer JWT) + `.expiresOn` (epoch secs), or null when no
// such entry exists / is malformed. Defensive: any bad input yields null, never throws.
function parseMsalBearer(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null
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
    if (!entry?.secret) continue
    const bearerExp = Number(entry.expiresOn)
    if (!Number.isFinite(bearerExp)) continue
    return { bearer: String(entry.secret), bearerExp }
  }
  return null
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
  parseMsalBearer,
  decodeJwtClaims,
  markFresh,
  markStale,
  redact,
}
