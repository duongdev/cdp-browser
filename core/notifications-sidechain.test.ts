import { beforeEach, describe, expect, it, vi } from "vitest"
// CommonJS shared core — both main.js and web/server.mjs consume it.
import { createNotificationCenter } from "./notifications-sidechain"

// A fake `ws`-shaped socket: records sent CDP commands and lets a test drive
// open/message/close/error like the real `ws` EventEmitter surface.
class FakeWs {
  url: string
  sent: any[] = []
  closed = false
  listeners: Record<string, ((...a: any[]) => void)[]> = {}
  static OPEN = 1
  readyState = 1
  constructor(url: string) {
    this.url = url
    FakeWs.instances.push(this)
  }
  static instances: FakeWs[] = []
  on(ev: string, fn: (...a: any[]) => void) {
    this.listeners[ev] ||= []
    this.listeners[ev].push(fn)
    return this
  }
  emit(ev: string, ...args: any[]) {
    for (const fn of this.listeners[ev] || []) fn(...args)
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw))
  }
  close() {
    this.closed = true
    this.emit("close")
  }
  // Helpers for tests
  open() {
    this.emit("open")
  }
  deliver(method: string, params: any) {
    this.emit("message", Buffer.from(JSON.stringify({ method, params })))
  }
  notify(payload: any) {
    this.deliver("Runtime.bindingCalled", {
      name: "__cdpNotify",
      payload: JSON.stringify(payload),
    })
  }
}

const TEAMS_URL = "https://teams.microsoft.com/v2/"
const OUTLOOK_URL = "https://outlook.office.com/mail/"
const teamsTarget = (over = {}) => ({
  id: "t1",
  type: "page",
  url: TEAMS_URL,
  webSocketDebuggerUrl: "ws://host/devtools/page/t1",
  ...over,
})
const outlookTarget = (over = {}) => ({
  id: "o1",
  type: "page",
  url: OUTLOOK_URL,
  webSocketDebuggerUrl: "ws://host/devtools/page/o1",
  ...over,
})

function makeCenter(over: Partial<any> = {}) {
  const saved: any[][] = []
  const onEntry = vi.fn()
  const readInject = vi.fn((name: string) => `/* source of ${name} */`)
  let nowVal = 1_000
  const deps = {
    readInject,
    listTargets: over.listTargets ?? (async () => []),
    load: over.load ?? (() => []),
    save: over.save ?? ((entries: any[]) => saved.push(entries)),
    now: over.now ?? (() => nowVal),
    WebSocketCtor: over.WebSocketCtor ?? (FakeWs as any),
    onEntry: over.onEntry ?? onEntry,
    ...over,
  }
  const center = createNotificationCenter(deps)
  return {
    center,
    onEntry: deps.onEntry as any,
    readInject,
    saved,
    setNow: (v: number) => {
      nowVal = v
    },
  }
}

beforeEach(() => {
  FakeWs.instances = []
})

describe("adapterFor", () => {
  it("matches a Teams URL to the teams adapter", () => {
    const { center } = makeCenter()
    expect(center.adapterFor(TEAMS_URL)?.name).toBe("teams")
  })
  it("matches an OWA URL to the outlook adapter", () => {
    const { center } = makeCenter()
    expect(center.adapterFor(OUTLOOK_URL)?.name).toBe("outlook")
  })
  it("returns null for an unmatched host", () => {
    const { center } = makeCenter()
    expect(center.adapterFor("https://example.com/")).toBeNull()
  })
  it("matches by hostname, not full URL", () => {
    const { center } = makeCenter()
    expect(center.adapterFor("https://teams.microsoft.com/anything?x=1#h")?.name).toBe("teams")
  })
})

describe("reconcile — attach", () => {
  it("opens one side-channel per matching target and injects the capture script at document-start", async () => {
    const { center, readInject } = makeCenter()
    await center.reconcile([teamsTarget(), { id: "x", type: "page", url: "https://example.com/" }])
    expect(FakeWs.instances).toHaveLength(1)
    const ws = FakeWs.instances[0]
    expect(ws.url).toBe("ws://host/devtools/page/t1")
    ws.open()
    const methods = ws.sent.map((m) => m.method)
    expect(methods).toContain("Runtime.enable")
    expect(methods).toContain("Page.enable")
    expect(methods).toContain("Runtime.addBinding")
    expect(methods).toContain("Page.addScriptToEvaluateOnNewDocument")
    expect(methods).toContain("Runtime.evaluate")
    const addBinding = ws.sent.find((m) => m.method === "Runtime.addBinding")
    expect(addBinding.params.name).toBe("__cdpNotify")
    const docStart = ws.sent.find((m) => m.method === "Page.addScriptToEvaluateOnNewDocument")
    expect(docStart.params.source).toContain("teams-notify.js")
    expect(readInject).toHaveBeenCalled()
  })

  it("does not attach to a non-matching target", async () => {
    const { center } = makeCenter()
    await center.reconcile([{ id: "x", type: "page", url: "https://example.com/" }])
    expect(FakeWs.instances).toHaveLength(0)
  })

  it("does not attach to a matching target with no webSocketDebuggerUrl", async () => {
    const { center } = makeCenter()
    await center.reconcile([teamsTarget({ webSocketDebuggerUrl: undefined })])
    expect(FakeWs.instances).toHaveLength(0)
  })
})

describe("reconcile — idempotent / drop", () => {
  it("opens no new socket when the target list is unchanged", async () => {
    const { center } = makeCenter()
    await center.reconcile([teamsTarget()])
    await center.reconcile([teamsTarget()])
    expect(FakeWs.instances).toHaveLength(1)
  })

  it("closes the side-channel for a target that disappeared", async () => {
    const { center } = makeCenter()
    await center.reconcile([teamsTarget()])
    const ws = FakeWs.instances[0]
    await center.reconcile([])
    expect(ws.closed).toBe(true)
  })

  it("drops a target whose URL changed to a non-matching host", async () => {
    const { center } = makeCenter()
    await center.reconcile([teamsTarget()])
    const ws = FakeWs.instances[0]
    await center.reconcile([teamsTarget({ url: "https://example.com/" })])
    expect(ws.closed).toBe(true)
  })
})

describe("keep-alive (t066) — prevent background-tab freeze", () => {
  it("forces the page web lifecycle to active on open so a backgrounded Tab keeps firing notifications", async () => {
    const { center } = makeCenter()
    await center.reconcile([teamsTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    const keepAlive = ws.sent.filter((m) => m.method === "Page.setWebLifecycleState")
    expect(keepAlive).toHaveLength(1)
    expect(keepAlive[0].params.state).toBe("active")
  })

  it("does not send keep-alive before the socket opens", async () => {
    const { center } = makeCenter()
    await center.reconcile([teamsTarget()])
    const ws = FakeWs.instances[0]
    const count = ws.sent.filter((m) => m.method === "Page.setWebLifecycleState").length
    expect(count).toBe(0)
  })

  it("re-applies keep-alive on each reconcile (browser may re-freeze the Tab)", async () => {
    const { center } = makeCenter()
    await center.reconcile([teamsTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    await center.reconcile([teamsTarget()]) // same target, socket already open
    const count = ws.sent.filter((m) => m.method === "Page.setWebLifecycleState").length
    expect(count).toBe(2)
  })
})

describe("ingest dedup", () => {
  it("drops a duplicate toast within the dedup window — one stored entry, one onEntry", async () => {
    const { center, onEntry } = makeCenter()
    await center.reconcile([teamsTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    ws.notify({ id: "n1", source: "Teams", title: "Hi", body: "there" })
    ws.notify({ id: "n1", source: "Teams", title: "Hi", body: "there" })
    expect(center.list()).toHaveLength(1)
    expect(onEntry).toHaveBeenCalledTimes(1)
  })
})

describe("ingest cap", () => {
  it("never exceeds the cap and evicts oldest first", async () => {
    const { center } = makeCenter({ cap: 3 })
    await center.reconcile([teamsTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    for (let i = 0; i < 5; i++) ws.notify({ id: `n${i}`, title: `t${i}` })
    expect(center.list().map((e: any) => e.id)).toEqual(["n4", "n3", "n2"])
  })
})

describe("entry.adapter stamp", () => {
  it("stamps the matched adapter name on each entry", async () => {
    const { center } = makeCenter()
    await center.reconcile([teamsTarget(), outlookTarget()])
    const [teamsWs, outlookWs] = FakeWs.instances
    teamsWs.open()
    outlookWs.open()
    teamsWs.notify({ id: "tn", title: "Teams toast" })
    outlookWs.notify({ id: "on", title: "Outlook toast" })
    const byId = Object.fromEntries(center.list().map((e: any) => [e.id, e]))
    expect(byId.tn.adapter).toBe("teams")
    expect(byId.on.adapter).toBe("outlook")
  })

  it("stamps the adapter iconUrl as entry.icon", async () => {
    const { center } = makeCenter()
    await center.reconcile([teamsTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    ws.notify({ id: "tn", title: "Teams toast" })
    expect(center.list()[0].icon).toContain("teams")
  })
})

describe("groupKey + activate seam (t028)", () => {
  it("defaults groupKey to the Tab's URL origin when the toast omits one", async () => {
    const { center } = makeCenter()
    await center.reconcile([teamsTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    ws.notify({ id: "tn", title: "Teams toast" })
    expect(center.list()[0].groupKey).toBe("https://teams.microsoft.com")
  })

  it("preserves an explicit groupKey emitted by the capture script", async () => {
    const { center } = makeCenter()
    await center.reconcile([teamsTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    ws.notify({ id: "tn", title: "Teams toast", groupKey: "slack:T7" })
    expect(center.list()[0].groupKey).toBe("slack:T7")
  })

  it("passes a normalized activate intent through untouched", async () => {
    const { center } = makeCenter()
    await center.reconcile([teamsTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    ws.notify({
      id: "tn",
      title: "Teams toast",
      activate: { type: "thread", id: "19:x@thread.v2" },
    })
    expect(center.list()[0].activate).toEqual({ type: "thread", id: "19:x@thread.v2" })
  })

  it("stamps activate: null when the toast emits none (Tab-only activation)", async () => {
    const { center } = makeCenter()
    await center.reconcile([teamsTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    ws.notify({ id: "tn", title: "meeting started" })
    expect(center.list()[0].activate).toBeNull()
  })
})

describe("slack adapter — per-workspace grouping (t064)", () => {
  const slackTarget = (id: string, teamId: string) => ({
    id,
    type: "page" as const,
    url: `https://app.slack.com/client/${teamId}/C001`,
    webSocketDebuggerUrl: `ws://host/devtools/page/${id}`,
  })

  it("matches any *.slack.com host to the slack adapter", () => {
    const { center } = makeCenter()
    expect(center.adapterFor("https://app.slack.com/client/T1/C1")?.name).toBe("slack")
    expect(center.adapterFor("https://acme.slack.com/messages")?.name).toBe("slack")
  })

  it("derives groupKey from the Tab URL team id (server-side), ignoring origin", async () => {
    const { center } = makeCenter()
    await center.reconcile([slackTarget("s1", "T111")])
    const ws = FakeWs.instances[0]
    ws.open()
    // The capture script ships no groupKey; the adapter's groupKey(url) hook supplies it.
    ws.notify({ id: "sn", title: "@alice: hi", source: "Acme" })
    expect(center.list()[0].groupKey).toBe("slack:T111")
  })

  it("buckets two workspaces sharing app.slack.com under distinct group keys", async () => {
    const { center } = makeCenter()
    await center.reconcile([slackTarget("s1", "T111"), slackTarget("s2", "T222")])
    const [wsA, wsB] = FakeWs.instances
    wsA.open()
    wsB.open()
    wsA.notify({ id: "a1", title: "ping A" })
    wsB.notify({ id: "b1", title: "ping B" })
    const keys = center.list().map((e: any) => e.groupKey)
    expect(new Set(keys)).toEqual(new Set(["slack:T111", "slack:T222"]))
  })

  it("passes a channel spa-link activate intent through untouched", async () => {
    const { center } = makeCenter()
    await center.reconcile([slackTarget("s1", "T111")])
    const ws = FakeWs.instances[0]
    ws.open()
    ws.notify({ id: "sn", title: "@alice", activate: { type: "spa-link", url: "/client/T111/C9" } })
    expect(center.list()[0].activate).toEqual({ type: "spa-link", url: "/client/T111/C9" })
  })
})

describe("service-worker capture (t067)", () => {
  const slackSwTarget = (id = "sw1", over = {}) => ({
    id,
    type: "service_worker" as const,
    url: "https://app.slack.com/service-worker.js",
    webSocketDebuggerUrl: `ws://host/devtools/worker/${id}`,
    ...over,
  })

  it("attaches to a service_worker target whose adapter declares a swScript and injects it via Runtime.evaluate (no Page domain)", async () => {
    const { center } = makeCenter()
    await center.reconcile([slackSwTarget()])
    expect(FakeWs.instances).toHaveLength(1)
    const ws = FakeWs.instances[0]
    ws.open()
    const methods = ws.sent.map((m) => m.method)
    expect(methods).toContain("Runtime.enable")
    expect(methods).toContain("Runtime.addBinding")
    expect(methods).toContain("Runtime.evaluate")
    expect(methods).not.toContain("Page.enable")
    expect(methods).not.toContain("Page.addScriptToEvaluateOnNewDocument")
    const evalCmd = ws.sent.find((m) => m.method === "Runtime.evaluate")
    expect(evalCmd.params.expression).toContain("slack-sw-notify.js")
  })

  it("does not attach to a service_worker whose adapter has no swScript (Teams)", async () => {
    const { center } = makeCenter()
    await center.reconcile([
      {
        id: "tsw",
        type: "service_worker",
        url: "https://teams.microsoft.com/sw.js",
        webSocketDebuggerUrl: "ws://host/devtools/worker/tsw",
      },
    ])
    expect(FakeWs.instances).toHaveLength(0)
  })

  it("ingests a toast from the SW channel, stamped with the slack adapter + payload groupKey", async () => {
    const { center } = makeCenter()
    await center.reconcile([slackSwTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    // SW URL has no team id, so the worker script supplies the per-workspace groupKey.
    ws.notify({ id: "swn", title: "@bob: ping", groupKey: "slack:T999" })
    expect(center.list()[0].adapter).toBe("slack")
    expect(center.list()[0].groupKey).toBe("slack:T999")
  })

  it("never sends keep-alive on a SW channel (no web lifecycle on a worker)", async () => {
    const { center } = makeCenter()
    await center.reconcile([slackSwTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    await center.reconcile([slackSwTarget()]) // triggers the keep-alive re-apply pass
    expect(ws.sent.filter((m) => m.method === "Page.setWebLifecycleState")).toHaveLength(0)
  })

  it("drops the SW channel when the worker vanishes", async () => {
    const { center } = makeCenter()
    await center.reconcile([slackSwTarget()])
    const ws = FakeWs.instances[0]
    await center.reconcile([])
    expect(ws.closed).toBe(true)
  })

  it("attaches both the page and the SW channel for the same workspace", async () => {
    const { center } = makeCenter()
    const slackPage = {
      id: "p1",
      type: "page" as const,
      url: "https://app.slack.com/client/T1/C1",
      webSocketDebuggerUrl: "ws://host/devtools/page/p1",
    }
    await center.reconcile([slackPage, slackSwTarget()])
    expect(FakeWs.instances).toHaveLength(2)
  })
})

describe("store mutations + persistence", () => {
  async function seeded() {
    const ctx = makeCenter()
    await ctx.center.reconcile([teamsTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    ws.notify({ id: "a", title: "A" })
    ws.notify({ id: "b", title: "B" })
    return ctx
  }

  it("list returns cap-ordered (newest-first) entries", async () => {
    const { center } = await seeded()
    expect(center.list().map((e: any) => e.id)).toEqual(["b", "a"])
  })

  it("markRead lowers unreadCount and persists", async () => {
    const { center, saved } = await seeded()
    expect(center.unreadCount()).toBe(2)
    const before = saved.length
    center.markRead("a")
    expect(center.unreadCount()).toBe(1)
    expect(saved.length).toBeGreaterThan(before)
  })

  it("markUnread raises unreadCount and persists", async () => {
    const { center } = await seeded()
    center.markRead("a")
    expect(center.unreadCount()).toBe(1)
    center.markUnread("a")
    expect(center.unreadCount()).toBe(2)
  })

  it("markAllRead zeroes unreadCount and persists", async () => {
    const { center, saved } = await seeded()
    const before = saved.length
    center.markAllRead()
    expect(center.unreadCount()).toBe(0)
    expect(saved.length).toBeGreaterThan(before)
  })

  it("clear empties the store and persists", async () => {
    const { center, saved } = await seeded()
    const before = saved.length
    center.clear()
    expect(center.list()).toEqual([])
    expect(center.unreadCount()).toBe(0)
    expect(saved.length).toBeGreaterThan(before)
  })
})

describe("onEntry firing", () => {
  it("fires exactly once per newly stored entry, zero for a deduped toast", async () => {
    const { center, onEntry } = makeCenter()
    await center.reconcile([teamsTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    ws.notify({ id: "a", title: "A" })
    ws.notify({ id: "b", title: "B" })
    ws.notify({ id: "a", title: "A again" }) // dup
    expect(onEntry).toHaveBeenCalledTimes(2)
  })

  it("ignores malformed binding payloads (bad JSON, missing id)", async () => {
    const { center, onEntry } = makeCenter()
    await center.reconcile([teamsTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    ws.deliver("Runtime.bindingCalled", { name: "__cdpNotify", payload: "not json" })
    ws.notify({ title: "no id" })
    expect(onEntry).not.toHaveBeenCalled()
    expect(center.list()).toEqual([])
  })
})

describe("load + close", () => {
  it("seeds the store from load() on construction", () => {
    const { center } = makeCenter({
      load: () => [{ id: "x", title: "old", read: false, adapter: "teams" }],
    })
    expect(center.list()).toHaveLength(1)
    expect(center.unreadCount()).toBe(1)
  })

  it("close tears down all side-channels", async () => {
    const { center } = makeCenter()
    await center.reconcile([teamsTarget(), outlookTarget()])
    center.close()
    expect(FakeWs.instances.every((w) => w.closed)).toBe(true)
  })
})
