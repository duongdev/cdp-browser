// Pure DM/group-DM name helpers for the Teams chat conversation list + thread header
// (t109, ADR-0018). A DM/group-DM has no topic, so the row falls back to "Direct message" /
// "Group chat" without these — here we derive the member MRIs (from the id for a 1:1, from the
// in-page roster fetch for a group-DM), resolve them to display names via Graph (in
// web/server.mjs, cached by MRI), and compose a human label. This module is I/O-free: id parsing
// + the title composer only. Every function is defensive — bad input yields a safe fallback,
// never a throw (the list must render even when name resolution fails).

// A 1:1 chat id encodes both members: `19:{a}_{b}@unq.gbl.spaces`, where each part is the AAD
// object id — LIVE Teams uses BARE oids here, not `8:orgid:` MRIs (verified against the running
// tenant). So compare on the normalized oid (`oidFromMri`, a no-op on a bare oid) to drop self
// regardless of which format the id or `selfMri` carries — a raw `!== selfMri` misses when the id
// is bare-oid and `selfMri` is `8:orgid:…`, leaving self in and mislabeling the DM. Split on `_`
// (an oid/orgid MRI has no underscore). A group-DM (`…@thread.v2`) has no members in its id → [].
function otherMrisFromId(convId, selfMri) {
  if (typeof convId !== "string" || !convId.includes("@unq.gbl.spaces")) return []
  const inner = convId.split("@")[0].replace(/^19:/, "")
  const selfOid = oidFromMri(selfMri)
  return inner.split("_").filter(Boolean).filter((m) => oidFromMri(m) !== selfOid)
}

// Graph's getByIds keys objects by the AAD object id, which is the MRI minus its `8:orgid:`
// namespace prefix. Self MRI = `8:orgid:{creds.userId}`.
function oidFromMri(mri) {
  return typeof mri === "string" ? mri.replace(/^8:orgid:/, "") : ""
}

// Show at most this many names before collapsing the rest into a "+N" overflow.
const GROUP_NAME_CAP = 3

// Compose the display title. Precedence: an explicit topic wins (any kind); else the resolved
// member names — a DM shows the single other name, a group-DM shows up to GROUP_NAME_CAP names
// with a "+N" overflow; else the kind fallback. `selfName` is filtered out defensively (the
// group roster fetch includes self). Missing/empty everything → "Direct message" / "Group chat".
function composeTitle(input = {}) {
  const { kind, topic, memberNames, selfName } = input
  const t = typeof topic === "string" ? topic.trim() : ""
  if (t) return t

  const self = typeof selfName === "string" ? selfName.trim() : ""
  const names = (Array.isArray(memberNames) ? memberNames : [])
    .map((n) => (typeof n === "string" ? n.trim() : ""))
    .filter((n) => n && n !== self)

  if (names.length === 0) return kind === "oneOnOne" ? "Direct message" : "Group chat"
  if (kind === "oneOnOne") return names[0]
  if (names.length <= GROUP_NAME_CAP) return names.join(", ")
  return `${names.slice(0, GROUP_NAME_CAP).join(", ")}, +${names.length - GROUP_NAME_CAP}`
}

module.exports = { otherMrisFromId, oidFromMri, composeTitle, GROUP_NAME_CAP }
