import { describe, expect, it } from "vitest"
// @ts-expect-error -- shared CJS core, no types (ADR-0008)
import { hermesTurnSessionId } from "./hermes-route.js"

/**
 * This predicate sits AHEAD of the `/api/chat/*` BFF proxy in web/server.mjs's
 * dispatch chain, so both failure directions are silent in production:
 *   over-match  -> session CRUD gets sent to Hermes, panel breaks
 *   under-match -> turns quietly keep using the old chat-server loop
 */

const turn = (p: string) => hermesTurnSessionId(p, "POST", true)

describe("hermesTurnSessionId", () => {
  it("matches a real turn", () => {
    expect(turn("/api/chat/assistant/abc-123")).toBe("abc-123")
  })

  it("matches a uuid session id", () => {
    const id = "3f8a1c02-9b4e-4d7a-8e15-2c6f0b9d4471"
    expect(turn(`/api/chat/assistant/${id}`)).toBe(id)
  })

  it("returns null when Hermes is not configured", () => {
    // The fallback that keeps a missing env var from becoming an outage.
    expect(hermesTurnSessionId("/api/chat/assistant/abc", "POST", false)).toBeNull()
  })

  it.each(["GET", "DELETE", "PATCH", "PUT"])("ignores %s on the turn path", (method) => {
    // GET on this exact path is chat-server's message history — diverting it
    // would blank the panel on every session open.
    expect(hermesTurnSessionId("/api/chat/assistant/abc", method, true)).toBeNull()
  })

  it.each(["sessions", "models", "prefs"])("does not swallow the sibling route %s", (name) => {
    expect(turn(`/api/chat/assistant/${name}`)).toBeNull()
  })

  it.each([
    ["nested sub-route", "/api/chat/assistant/abc/messages"],
    ["context sub-route", "/api/chat/assistant/sessions/abc/context"],
    ["prefix only", "/api/chat/assistant"],
    ["trailing slash", "/api/chat/assistant/"],
    ["different service", "/api/chat/history"],
    ["mcp", "/mcp"],
    ["unrelated api", "/api/tabs"],
    ["lookalike prefix", "/api/chat/assistantx/abc"],
  ])("ignores %s", (_label, path) => {
    expect(turn(path)).toBeNull()
  })

  it("rejects an encoded path separator", () => {
    // `sessions%2Fx` decodes to a different route than the one the regex matched.
    expect(turn("/api/chat/assistant/sessions%2Fx")).toBeNull()
  })

  // `?` and `#` are not path separators, so an earlier version let them through. But the
  // id is interpolated into `${root}/api/sessions/${id}/chat/stream`, and there `?` turns
  // the remainder into a query string: `a?x=1` addressed `/api/sessions/a` instead of
  // failing, so the turn ran against the wrong session with no error anywhere.
  it("rejects URL-structural characters that silently retarget the upstream call", () => {
    expect(turn("/api/chat/assistant/a%3Fx=1")).toBeNull()
    expect(turn("/api/chat/assistant/a%23frag")).toBeNull()
  })

  it("never returns an id that moves the upstream path when interpolated", () => {
    // States the property directly rather than enumerating bad characters, so a new
    // structural character can't slip past by not being on a list.
    for (const attempt of ["a%3Fx=1", "a%23f", "sessions%2Fx", "a%5Cb", "a%20b", "ok-id-123"]) {
      const id = turn(`/api/chat/assistant/${attempt}`)
      if (id === null) continue
      const built = new URL(`http://gw/api/sessions/${encodeURI(id)}/chat/stream`)
      expect(built.search).toBe("")
      expect(built.hash).toBe("")
      expect(built.pathname.endsWith("/chat/stream")).toBe(true)
    }
  })

  it("only matches at the start of the path", () => {
    // An unanchored pattern would match the turn route embedded anywhere, so a
    // path this server never issues could still reach the agent.
    expect(turn("/x/api/chat/assistant/abc")).toBeNull()
    expect(turn("/api/chat/history/api/chat/assistant/abc")).toBeNull()
  })

  it("rejects malformed percent-encoding instead of throwing", () => {
    // decodeURIComponent throws on a lone `%`; an uncaught throw here would 500
    // the whole request rather than falling through to the BFF.
    expect(() => turn("/api/chat/assistant/%E0%A4%A")).not.toThrow()
    expect(turn("/api/chat/assistant/%E0%A4%A")).toBeNull()
  })

  it("decodes a percent-encoded id", () => {
    expect(turn("/api/chat/assistant/a%20b")).toBe("a b")
  })
})
