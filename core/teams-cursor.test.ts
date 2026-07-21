import { describe, expect, it } from "vitest"
// Pagination-cursor security gate (t112, ADR-0018). The cursor is a server-fetched IN-PAGE URL
// carrying the skypetoken, so only an https URL under the account's own chatServiceBase is safe.
import { isValidTeamsCursor } from "./teams-cursor"

const BASE = "https://apac.ng.msg.teams.microsoft.com"

describe("isValidTeamsCursor", () => {
  it("accepts a backwardLink under the chatServiceBase", () => {
    const cursor = `${BASE}/v1/users/ME/conversations/19:abc@unq.gbl.spaces/messages?pageSize=30&syncState=OPAQUE`
    expect(isValidTeamsCursor(cursor, BASE)).toBe(true)
  })

  it("rejects a different host (SSRF / token exfiltration)", () => {
    expect(isValidTeamsCursor("https://evil.com/steal", BASE)).toBe(false)
  })

  it("rejects a look-alike host suffix — the trailing slash pins the authority", () => {
    expect(isValidTeamsCursor(`${BASE}.evil.com/v1/x`, BASE)).toBe(false)
    expect(isValidTeamsCursor(`${BASE}@evil.com/v1/x`, BASE)).toBe(false)
  })

  it("rejects a non-https scheme", () => {
    expect(isValidTeamsCursor(`http://apac.ng.msg.teams.microsoft.com/v1/x`, BASE)).toBe(false)
  })

  it("rejects empty / non-string cursor", () => {
    expect(isValidTeamsCursor("", BASE)).toBe(false)
    expect(isValidTeamsCursor(undefined, BASE)).toBe(false)
    expect(isValidTeamsCursor(null, BASE)).toBe(false)
    expect(isValidTeamsCursor(42, BASE)).toBe(false)
  })

  it("rejects when chatServiceBase is empty / non-string", () => {
    expect(isValidTeamsCursor(`${BASE}/v1/x`, "")).toBe(false)
    expect(isValidTeamsCursor(`${BASE}/v1/x`, undefined)).toBe(false)
  })

  it("rejects the base itself with no path (needs the trailing slash + a page)", () => {
    expect(isValidTeamsCursor(BASE, BASE)).toBe(false)
  })
})
