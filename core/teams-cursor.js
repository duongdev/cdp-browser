// Pagination-cursor security gate for the Teams chat backend (t134, ADR-0019). Older pages are
// loaded by fetching the previous response's `_metadata.backwardLink` — a FULL URL the server
// fetches IN-PAGE with the skypetoken. A client supplies that cursor back to page further, so a
// malicious/garbled cursor must not be able to make the server fetch an arbitrary URL (skypetoken
// exfiltration / SSRF). This is the single gate: a cursor is honoured only when it is an https URL
// under the account's own chatServiceBase. The trailing "/" pins the authority — `<base>.evil.com`
// or `<base>@evil.com` both fail the prefix (the char after `<base>` is not `/`).
function isValidTeamsCursor(url, chatServiceBase) {
  if (typeof url !== "string" || typeof chatServiceBase !== "string" || !chatServiceBase)
    return false
  if (!url.startsWith("https://")) return false
  return url.startsWith(`${chatServiceBase}/`)
}

module.exports = { isValidTeamsCursor }
