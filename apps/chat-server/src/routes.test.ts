import Database from "better-sqlite3"
import { Hono } from "hono"
import { beforeEach, describe, expect, test } from "vitest"
import type { ChatService } from "./contract.ts"
import { MockProvider } from "./providers/mock-provider.ts"
import type { ChatProvider } from "./providers/provider.ts"
import { createRoutes } from "./routes.ts"
import { listConversations, listMessages, migrate } from "./store.ts"

const SERVICE = "mock"
const GROUP = "19:group@thread.v2"

function makeApp() {
  const db = migrate(new Database(":memory:"))
  const providers = new Map<ChatService, ChatProvider>([[SERVICE, new MockProvider(SERVICE)]])
  const app = new Hono()
  app.route("/api/chat", createRoutes({ db, providers }))
  return { app, db }
}

const post = (app: Hono, path: string, body: unknown) =>
  app.request(`/api/chat/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

describe("read routes persist + return", () => {
  let ctx: ReturnType<typeof makeApp>
  beforeEach(() => {
    ctx = makeApp()
  })

  test("conversations returns the page and upserts the store", async () => {
    const res = await post(ctx.app, "conversations", { service: SERVICE })
    expect(res.status).toBe(200)
    const page = (await res.json()) as any
    expect(page.conversations.length).toBeGreaterThan(0)
    expect(listConversations(ctx.db, SERVICE).length).toBe(page.conversations.length)
  })

  test("history returns messages and upserts them", async () => {
    const res = await post(ctx.app, "history", { service: SERVICE, convId: GROUP })
    expect(res.status).toBe(200)
    const page = (await res.json()) as any
    expect(page.messages.length).toBeGreaterThan(0)
    expect(listMessages(ctx.db, SERVICE, GROUP).length).toBe(page.messages.length)
  })
})

describe("write routes roundtrip through the provider", () => {
  let ctx: ReturnType<typeof makeApp>
  beforeEach(() => {
    ctx = makeApp()
  })

  test("reply returns a SendResult", async () => {
    const res = await post(ctx.app, "reply", { service: SERVICE, convId: GROUP, text: "hi" })
    expect(res.status).toBe(200)
    const r = (await res.json()) as any
    expect(r.ok).toBe(true)
    expect(typeof r.ts).toBe("string")
  })

  test("react ok", async () => {
    // seed history so the message exists in the provider
    await post(ctx.app, "history", { service: SERVICE, convId: GROUP })
    const res = await post(ctx.app, "react", {
      service: SERVICE,
      convId: GROUP,
      msgId: "3004",
      key: "like",
      remove: false,
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as any).toEqual({ ok: true })
  })
})

describe("local-only + errors", () => {
  test("prefs GET/POST is store-local", async () => {
    const { app } = makeApp()
    await post(app, "prefs", { service: SERVICE, convId: GROUP, folder: "Work" })
    const res = await app.request(`/api/chat/prefs?service=${SERVICE}`)
    const out = (await res.json()) as any
    expect(out.prefs[GROUP].folder).toBe("Work")
  })

  test("read-local mark-unread ok without a provider call", async () => {
    const { app } = makeApp()
    const res = await post(app, "read-local", { service: SERVICE, convId: GROUP, action: "unread" })
    expect(res.status).toBe(200)
  })

  test("unknown service → typed 400", async () => {
    const { app } = makeApp()
    const res = await post(app, "conversations", { service: "nope" })
    expect(res.status).toBe(400)
    expect((await res.json()) as any).toEqual({ error: "unknown_service" })
  })

  test("provider not_found surfaces as typed 404", async () => {
    const { app } = makeApp()
    const res = await post(app, "history", { service: SERVICE, convId: "19:missing@thread.v2" })
    expect(res.status).toBe(404)
    expect((await res.json()) as any).toEqual({ error: "not_found" })
  })

  test("backfill status is a stub", async () => {
    const { app } = makeApp()
    const res = await app.request(`/api/chat/backfill?service=${SERVICE}`)
    const out = (await res.json()) as any
    expect(out.running).toBe(false)
    expect(out.days).toBe(30)
  })
})
