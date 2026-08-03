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

  // Read state is written THROUGH to the provider, then mirrored locally — so a round-trip of
  // mark-unread → mark-read must land on the provider AND leave the row read.
  test("mark-unread then mark-read write through to the provider", async () => {
    const { app, db } = makeApp()
    await post(app, "conversations", { service: SERVICE })
    const lastTs = listConversations(db, SERVICE).find((c) => c.id === GROUP)
      ?.lastMessageTs as number

    expect(
      (await post(app, "mark-unread", { service: SERVICE, convId: GROUP, ts: lastTs })).status,
    ).toBe(200)
    await post(app, "conversations", { service: SERVICE }) // re-sync from the provider
    expect(listConversations(db, SERVICE).find((c) => c.id === GROUP)?.unreadSticky).toBe(true)

    expect(
      (await post(app, "mark-read", { service: SERVICE, convId: GROUP, msgId: "m", ts: lastTs }))
        .status,
    ).toBe(200)
    await post(app, "conversations", { service: SERVICE })
    const row = listConversations(db, SERVICE).find((c) => c.id === GROUP)
    expect(row?.unreadSticky).toBe(false)
    expect(row?.readTs).toBe(lastTs)
  })

  test("mark-unread without a convId → typed 400", async () => {
    const { app } = makeApp()
    expect((await post(app, "mark-unread", { service: SERVICE })).status).toBe(400)
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

describe("reply suggestion routes (ADR-0027)", () => {
  // A local hub stand-in: the routes take `broadcast` as a dep precisely so a test can watch the
  // fan-out without booting a server.
  function makeAppWithHub() {
    const db = migrate(new Database(":memory:"))
    const providers = new Map<ChatService, ChatProvider>([[SERVICE, new MockProvider(SERVICE)]])
    const frames: any[] = []
    const app = new Hono()
    app.route("/api/chat", createRoutes({ db, providers, broadcast: (m) => frames.push(m) }))
    return { app, db, frames }
  }

  let ctx: ReturnType<typeof makeAppWithHub>
  beforeEach(() => {
    ctx = makeAppWithHub()
  })

  const write = (texts = ["one", "two"], convId = GROUP) =>
    post(ctx.app, "suggestions", { service: SERVICE, convId, texts, producer: "hermes" })

  test("POST stores a batch and broadcasts it", async () => {
    const res = await write()
    expect(res.status).toBe(200)
    const { batch } = (await res.json()) as any
    expect(batch.texts).toEqual(["one", "two"])
    expect(ctx.frames).toHaveLength(1)
    expect(ctx.frames[0]).toMatchObject({
      type: "reply-suggestions",
      service: SERVICE,
      convId: GROUP,
    })
    expect(ctx.frames[0].batch.id).toBe(batch.id)
  })

  test("GET hydrates — the WS carries deltas only, a late client needs this", async () => {
    const { batch } = (await (await write()).json()) as any
    const res = await ctx.app.request(
      `/api/chat/suggestions?service=${SERVICE}&convId=${encodeURIComponent(GROUP)}`,
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).batch.id).toBe(batch.id)
  })

  test("GET returns a null batch for a conversation with none", async () => {
    const res = await ctx.app.request(`/api/chat/suggestions?service=${SERVICE}&convId=nope`)
    expect(((await res.json()) as any).batch).toBeNull()
  })

  test("GET without convId is a 400, not an empty answer", async () => {
    expect((await ctx.app.request(`/api/chat/suggestions?service=${SERVICE}`)).status).toBe(400)
  })

  test("choose records the pick and broadcasts the updated batch", async () => {
    const { batch } = (await (await write()).json()) as any
    const res = await post(ctx.app, "suggestions/choose", {
      service: SERVICE,
      id: batch.id,
      idx: 1,
    })
    expect(res.status).toBe(200)
    const updated = ((await res.json()) as any).batch
    expect(updated.chosenIdx).toBe(1)
    expect(updated.status).toBe("chosen")
    expect(ctx.frames.at(-1).batch.chosenIdx).toBe(1)
  })

  test("choose does NOT send — no message reaches the store (ADR-0027 decision 6)", async () => {
    const before = listMessages(ctx.db, SERVICE, GROUP).length
    const { batch } = (await (await write()).json()) as any
    await post(ctx.app, "suggestions/choose", { service: SERVICE, id: batch.id, idx: 0 })
    expect(listMessages(ctx.db, SERVICE, GROUP).length).toBe(before)
  })

  test("choose with an out-of-range idx is a 400", async () => {
    const { batch } = (await (await write(["only one"])).json()) as any
    const res = await post(ctx.app, "suggestions/choose", {
      service: SERVICE,
      id: batch.id,
      idx: 5,
    })
    expect(res.status).toBe(400)
  })

  test("choose on an unknown batch is a 404", async () => {
    const res = await post(ctx.app, "suggestions/choose", { service: SERVICE, id: 4242, idx: 0 })
    expect(res.status).toBe(404)
  })

  test("dismiss clears the strip with a null batch frame, row survives", async () => {
    const { batch } = (await (await write()).json()) as any
    const res = await post(ctx.app, "suggestions/dismiss", { service: SERVICE, id: batch.id })
    expect(res.status).toBe(200)
    expect(ctx.frames.at(-1)).toMatchObject({ type: "reply-suggestions", batch: null })
    const get = await ctx.app.request(
      `/api/chat/suggestions?service=${SERVICE}&convId=${encodeURIComponent(GROUP)}`,
    )
    expect(((await get.json()) as any).batch).toBeNull()
  })

  test("dismiss on an unknown batch is a 404", async () => {
    expect(
      (await post(ctx.app, "suggestions/dismiss", { service: SERVICE, id: 4242 })).status,
    ).toBe(404)
  })

  test("an empty batch is rejected at the route, not stored", async () => {
    expect((await write([])).status).toBe(400)
  })

  test("non-array texts is a 400", async () => {
    const res = await post(ctx.app, "suggestions", {
      service: SERVICE,
      convId: GROUP,
      texts: "not an array",
      producer: "hermes",
    })
    expect(res.status).toBe(400)
  })

  test("a second batch supersedes the first over the wire too", async () => {
    const first = ((await (await write(["a"])).json()) as any).batch
    const second = ((await (await write(["b"])).json()) as any).batch
    const get = await ctx.app.request(
      `/api/chat/suggestions?service=${SERVICE}&convId=${encodeURIComponent(GROUP)}`,
    )
    const live = ((await get.json()) as any).batch
    expect(live.id).toBe(second.id)
    expect(live.id).not.toBe(first.id)
  })

  test("routes work without a broadcast dep — clients fall back to the GET hydrate", async () => {
    const db = migrate(new Database(":memory:"))
    const providers = new Map<ChatService, ChatProvider>([[SERVICE, new MockProvider(SERVICE)]])
    const app = new Hono()
    app.route("/api/chat", createRoutes({ db, providers }))
    const res = await post(app, "suggestions", {
      service: SERVICE,
      convId: GROUP,
      texts: ["x"],
      producer: "hermes",
    })
    expect(res.status).toBe(200)
  })
})

describe("send attribution through the reply route (PSN-145)", () => {
  function makeAppWithHub() {
    const db = migrate(new Database(":memory:"))
    const providers = new Map<ChatService, ChatProvider>([[SERVICE, new MockProvider(SERVICE)]])
    const frames: any[] = []
    const app = new Hono()
    app.route("/api/chat", createRoutes({ db, providers, broadcast: (m) => frames.push(m) }))
    return { app, db, frames }
  }

  let ctx: ReturnType<typeof makeAppWithHub>
  beforeEach(() => {
    ctx = makeAppWithHub()
  })

  const suggest = (texts = ["draft version"]) =>
    post(ctx.app, "suggestions", { service: SERVICE, convId: GROUP, texts, producer: "hermes" })

  const live = async () => {
    const r = await ctx.app.request(
      `/api/chat/suggestions?service=${SERVICE}&convId=${encodeURIComponent(GROUP)}`,
    )
    return ((await r.json()) as any).batch
  }

  test("choose then reply pairs what was suggested with what was actually sent", async () => {
    const { batch } = (await (await suggest()).json()) as any
    await post(ctx.app, "suggestions/choose", { service: SERVICE, id: batch.id, idx: 0 })
    const res = await post(ctx.app, "reply", {
      service: SERVICE,
      convId: GROUP,
      text: "draft version, but reworded",
    })
    expect(res.status).toBe(200)
    const after = await live()
    expect(after.sentText).toBe("draft version, but reworded")
    expect(after.sentMsgId).toBeTruthy()
    // The diff is the deliverable: offered vs sent.
    expect(after.texts[after.chosenIdx]).toBe("draft version")
  })

  test("attribution broadcasts so an open UI sees the pair without a refetch", async () => {
    const { batch } = (await (await suggest()).json()) as any
    await post(ctx.app, "suggestions/choose", { service: SERVICE, id: batch.id, idx: 0 })
    ctx.frames.length = 0
    await post(ctx.app, "reply", { service: SERVICE, convId: GROUP, text: "sent it" })
    expect(ctx.frames.at(-1)).toMatchObject({ type: "reply-suggestions", convId: GROUP })
    expect(ctx.frames.at(-1).batch.sentText).toBe("sent it")
  })

  test("replying with no chosen batch records nothing and still returns the SendResult", async () => {
    await suggest() // open, never chosen
    const res = await post(ctx.app, "reply", { service: SERVICE, convId: GROUP, text: "typed it" })
    expect(res.status).toBe(200)
    expect((await res.json()) as any).toMatchObject({ ok: true })
    expect((await live()).sentAt).toBeNull()
  })

  test("replying into a conversation that never had suggestions is unaffected", async () => {
    const res = await post(ctx.app, "reply", { service: SERVICE, convId: GROUP, text: "hi" })
    expect(res.status).toBe(200)
    expect(await live()).toBeNull()
  })

  test("only the first reply attributes", async () => {
    const { batch } = (await (await suggest()).json()) as any
    await post(ctx.app, "suggestions/choose", { service: SERVICE, id: batch.id, idx: 0 })
    await post(ctx.app, "reply", { service: SERVICE, convId: GROUP, text: "first" })
    await post(ctx.app, "reply", { service: SERVICE, convId: GROUP, text: "second" })
    expect((await live()).sentText).toBe("first")
  })

  test("a failed send attributes nothing — provider first, record after (ADR-0022)", async () => {
    const db = migrate(new Database(":memory:"))
    const failing = new MockProvider(SERVICE)
    failing.sendReply = async () => {
      throw new Error("provider exploded")
    }
    const providers = new Map<ChatService, ChatProvider>([[SERVICE, failing]])
    const app = new Hono()
    app.route("/api/chat", createRoutes({ db, providers }))

    const { batch } = (await (
      await post(app, "suggestions", {
        service: SERVICE,
        convId: GROUP,
        texts: ["a"],
        producer: "hermes",
      })
    ).json()) as any
    await post(app, "suggestions/choose", { service: SERVICE, id: batch.id, idx: 0 })
    const res = await post(app, "reply", { service: SERVICE, convId: GROUP, text: "never landed" })
    expect(res.status).toBeGreaterThanOrEqual(400)

    const get = await app.request(
      `/api/chat/suggestions?service=${SERVICE}&convId=${encodeURIComponent(GROUP)}`,
    )
    expect(((await get.json()) as any).batch.sentAt).toBeNull()
  })

  test("diverged endpoint returns only edited sends", async () => {
    const a = (await (await suggest(["exact"])).json()) as any
    await post(ctx.app, "suggestions/choose", { service: SERVICE, id: a.batch.id, idx: 0 })
    await post(ctx.app, "reply", { service: SERVICE, convId: GROUP, text: "exact" })

    // A second conversation the mock provider actually knows — an unseeded id makes /reply 404,
    // which would silently give this test an empty list for the wrong reason.
    const other = "19:rich@thread.v2"
    const b = (await (
      await post(ctx.app, "suggestions", {
        service: SERVICE,
        convId: other,
        texts: ["draft"],
        producer: "hermes",
      })
    ).json()) as any
    await post(ctx.app, "suggestions/choose", { service: SERVICE, id: b.batch.id, idx: 0 })
    const sent = await post(ctx.app, "reply", {
      service: SERVICE,
      convId: other,
      text: "draft, edited",
    })
    expect(sent.status).toBe(200)

    const res = await ctx.app.request(`/api/chat/suggestions/diverged?service=${SERVICE}`)
    expect(res.status).toBe(200)
    const { batches } = (await res.json()) as any
    expect(batches).toHaveLength(1)
    expect(batches[0].convId).toBe(other)
    expect(batches[0].sentText).toBe("draft, edited")
  })
})
