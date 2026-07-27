import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { startMockUpstream } from "../../test/mock-upstream.mjs"
import { ProviderError } from "./provider.ts"
import { TeamsProvider } from "./teams-provider.ts"

describe("TeamsProvider over HTTP (mock upstream)", () => {
  let upstream: Awaited<ReturnType<typeof startMockUpstream>>
  let provider: TeamsProvider

  beforeAll(async () => {
    upstream = await startMockUpstream()
    provider = new TeamsProvider({ baseUrl: upstream.url, secret: upstream.secret })
  })
  afterAll(async () => {
    await upstream.close()
  })

  test("maps conversations and stamps service", async () => {
    const { conversations } = await provider.listConversations()
    expect(conversations.map((c) => c.id)).toContain("48:notes")
    expect(conversations.every((c) => c.service === "teams")).toBe(true)
  })

  test("history paging chains over HTTP", async () => {
    const first = await provider.fetchHistory("19:group@thread.v2")
    expect(first.messages.map((m) => m.id)).toEqual(["3003", "3004"])
    expect(first.messages.every((m) => m.service === "teams")).toBe(true)
    const second = await provider.fetchHistory("19:group@thread.v2", first.cursor)
    expect(second.cursor).toBeNull()
  })

  test("reply maps clientmessageid → clientMessageId", async () => {
    const r = await provider.sendReply("48:notes", "hello")
    expect(r.ok).toBe(true)
    expect(r.clientMessageId).toMatch(/^cmid-/)
    expect(r.ts).toBe(r.clientMessageId.replace("cmid-", ""))
  })

  test("roster maps Teams mri → contract id", async () => {
    const members = await provider.roster("19:oneonone@unq.gbl.spaces")
    // The internal wire uses `mri`; the provider must expose `id`.
    expect(members[0]).toHaveProperty("id")
    expect(members.find((m) => m.self)?.id).toBe("8:orgid:self-oid")
    expect(members.some((m) => "mri" in m)).toBe(false)
  })

  test("avatar + media decode base64 to bytes; avatar miss passes through", async () => {
    const a = await provider.avatar("other-oid")
    expect("body" in a && a.contentType).toBe("image/png")
    // Assert the PNG signature rather than the whole fixture — the upstream mock serves a real
    // decodable image (the profile dialog needs one to enable its avatar button), so pinning the
    // exact byte length would just re-break whenever that placeholder changes.
    expect("body" in a && Array.from(a.body.slice(0, 4))).toEqual([137, 80, 78, 71])
    expect(await provider.avatar("no-photo-oid")).toEqual({ miss: true })

    const m = await provider.media("https://ams.example/obj")
    expect(m.contentType).toBe("image/png")
  })

  test("upstream typed error propagates as ProviderError", async () => {
    await expect(provider.fetchHistory("does-not-exist")).rejects.toBeInstanceOf(ProviderError)
    await expect(provider.fetchHistory("does-not-exist")).rejects.toMatchObject({
      code: "not_found",
    })
  })

  test("secret guard: a wrong/absent secret 403s", async () => {
    const bad = new TeamsProvider({ baseUrl: upstream.url, secret: "wrong" })
    await expect(bad.listConversations()).rejects.toMatchObject({ code: "forbidden", status: 403 })

    const none = new TeamsProvider({ baseUrl: upstream.url, secret: "" })
    await expect(none.listConversations()).rejects.toMatchObject({ status: 403 })
  })
})
