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
  // Reply to a previously-sent command by id (drives cdpCall's pending map).
  reply(id: number, result: any) {
    this.emit("message", Buffer.from(JSON.stringify({ id, result })))
  }
  // Find the id of the last sent command matching a method (for reply correlation).
  lastId(method: string): number {
    const m = [...this.sent].reverse().find((x) => x.method === method)
    return m?.id
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
const SLACK_URL = "https://app.slack.com/client/T0EXAMPLE02/C0EXAMPLE02"
const slackTarget = (over = {}) => ({
  id: "s1",
  type: "page",
  url: SLACK_URL,
  webSocketDebuggerUrl: "ws://host/devtools/page/s1",
  ...over,
})
const LOCAL_CONFIG = JSON.stringify({
  lastActiveTeamId: "T0EXAMPLE02",
  teams: {
    T0EXAMPLE02: { token: "xoxc-aaa", name: "Acme", url: "https://acme.slack.com/" },
    E0EXAMPLE01: { token: "xoxc-bbb", name: "BigCo", url: "https://big.enterprise.slack.com/" },
    // A Grid child carrying its org's enterprise_id (t092) — flows onto the cred record.
    T0EXAMPLE01: {
      token: "xoxc-ccc",
      name: "BigCo WS",
      url: "https://bigws.slack.com/",
      enterprise_id: "E0EXAMPLE01",
    },
  },
})
// Drive the two-step cred extraction (Runtime.evaluate localConfig → Network.getCookies).
// The extractor awaits each reply, so `Network.getCookies` is only sent after the eval
// reply resolves on the next microtask — hence the awaits between replies.
async function answerCredExtraction(
  ws: FakeWs,
  opts: { config?: string; dCookie?: string | null } = {},
) {
  const config = opts.config ?? LOCAL_CONFIG
  const dCookie = opts.dCookie === undefined ? "xoxd-secret" : opts.dCookie
  // The first Runtime.evaluate is the capture-script injection; the cred read is the one
  // whose expression mentions localConfig_v2 — match by id of that specific send.
  const evalSend = [...ws.sent]
    .reverse()
    .find(
      (m) =>
        m.method === "Runtime.evaluate" && String(m.params?.expression).includes("localConfig_v2"),
    )
  if (evalSend) ws.reply(evalSend.id, { result: { value: config } })
  await Promise.resolve()
  await Promise.resolve()
  const cookieSend = [...ws.sent].reverse().find((m) => m.method === "Network.getCookies")
  if (cookieSend) {
    const cookies =
      dCookie === null ? [{ name: "lc", value: "x" }] : [{ name: "d", value: dCookie }]
    ws.reply(cookieSend.id, { cookies })
  }
  await Promise.resolve()
  await Promise.resolve()
}

// ---- Teams cred extraction helpers (t127) ----------------------------------
const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url")
const fakeJwt = (claims: Record<string, unknown>) =>
  `${b64url({ alg: "none" })}.${b64url(claims)}.sig`

// Drive the two-step Teams mint: MSAL dump (returnByValue) → authz POST (awaitPromise). The
// extractor awaits each reply, so the authz send only appears after the dump reply resolves.
async function answerTeamsMint(
  ws: FakeWs,
  opts: {
    tid?: string
    oid?: string
    bearerExp?: number
    skypeToken?: string
    chatServiceBase?: string
    trouterUrl?: string
    authzError?: string
    noBearer?: boolean
  } = {},
) {
  const tid = opts.tid ?? "TENANT-1"
  const oid = opts.oid ?? "USER-1"
  const bearerExp = opts.bearerExp ?? 1_750_000_000
  const dumpSend = [...ws.sent]
    .reverse()
    .find(
      (m) =>
        m.method === "Runtime.evaluate" &&
        String(m.params?.expression).includes("localStorage") &&
        String(m.params?.expression).includes("accesstoken"),
    )
  if (dumpSend) {
    const key =
      "msal.acc-login.windows.net-accesstoken-5e3ce6c0-tenant-https://api.spaces.skype.com/x--"
    const snap = opts.noBearer
      ? {}
      : { [key]: JSON.stringify({ secret: fakeJwt({ tid, oid }), expiresOn: String(bearerExp) }) }
    ws.reply(dumpSend.id, { result: { value: snap } })
  }
  await Promise.resolve()
  await Promise.resolve()
  const authzSend = [...ws.sent]
    .reverse()
    .find(
      (m) => m.method === "Runtime.evaluate" && String(m.params?.expression).includes("authsvc"),
    )
  if (authzSend) {
    const value = opts.authzError
      ? { error: opts.authzError }
      : {
          skypeToken: opts.skypeToken ?? "skype-XYZ",
          chatServiceBase: opts.chatServiceBase ?? "https://apac.ng.msg.teams.microsoft.com",
          trouterUrl: opts.trouterUrl ?? "https://trouter.example/",
        }
    ws.reply(authzSend.id, { result: { value } })
  }
  await Promise.resolve()
  await Promise.resolve()
}

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

describe("slack cred extraction (t069)", () => {
  it("extracts token + cookie per workspace when onCreds is provided", async () => {
    const onCreds = vi.fn()
    const { center } = makeCenter({ onCreds })
    await center.reconcile([slackTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    await answerCredExtraction(ws)
    const creds = center.listCreds()
    expect(creds.map((c: any) => c.teamId).sort()).toEqual([
      "E0EXAMPLE01",
      "T0EXAMPLE01",
      "T0EXAMPLE02",
    ])
    const acme = center.getCreds("T0EXAMPLE02")
    expect(acme).toMatchObject({ token: "xoxc-aaa", cookie: "xoxd-secret", fresh: true })
    expect(onCreds).toHaveBeenCalled()
  })

  it("carries enterpriseId onto the cred record for a Grid child (t092)", async () => {
    const onCreds = vi.fn()
    const { center } = makeCenter({ onCreds })
    await center.reconcile([slackTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    await answerCredExtraction(ws)
    expect(center.getCreds("T0EXAMPLE01")).toMatchObject({ enterpriseId: "E0EXAMPLE01" })
    // A standalone team (no enterprise_id) keeps an empty string — groupId falls to teamId.
    expect(center.getCreds("T0EXAMPLE02")?.enterpriseId).toBe("")
  })

  it("does not extract creds when onCreds is absent (Electron / no sweep)", async () => {
    const { center } = makeCenter()
    await center.reconcile([slackTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    // No localConfig read should have been sent.
    const credRead = ws.sent.find(
      (m: any) =>
        m.method === "Runtime.evaluate" && String(m.params?.expression).includes("localConfig_v2"),
    )
    expect(credRead).toBeUndefined()
    expect(center.listCreds()).toEqual([])
  })

  it("records nothing when the d cookie is missing", async () => {
    const onCreds = vi.fn()
    const { center } = makeCenter({ onCreds })
    await center.reconcile([slackTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    await answerCredExtraction(ws, { dCookie: null })
    expect(center.listCreds()).toEqual([])
    expect(onCreds).not.toHaveBeenCalled()
  })

  it("markCredsStale flips fresh→false but keeps the creds", async () => {
    const onCreds = vi.fn()
    const { center } = makeCenter({ onCreds })
    await center.reconcile([slackTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    await answerCredExtraction(ws)
    center.markCredsStale("T0EXAMPLE02", "invalid_auth")
    const rec = center.getCreds("T0EXAMPLE02")
    expect(rec).toMatchObject({ fresh: false, lastError: "invalid_auth", token: "xoxc-aaa" })
  })

  it("setSelfUserId caches the self user id on the cred record", async () => {
    const onCreds = vi.fn()
    const { center } = makeCenter({ onCreds })
    await center.reconcile([slackTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    await answerCredExtraction(ws)
    center.setSelfUserId("T0EXAMPLE02", "U_ME")
    expect(center.getCreds("T0EXAMPLE02")?.selfUserId).toBe("U_ME")
  })

  it("markCredsStale re-extracts over the live socket; a rotated token clears the stale state (t099)", async () => {
    const onCreds = vi.fn()
    const onCredsStuck = vi.fn()
    const { center } = makeCenter({ onCreds, onCredsStuck, onSlackSignal: vi.fn() })
    await center.reconcile([slackTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    await answerCredExtraction(ws)

    center.markCredsStale("T0EXAMPLE02", "invalid_auth") // fires refreshCreds()
    await Promise.resolve()
    // Slack rotated the token in localConfig — the re-extract reads the fresh value.
    const rotated = JSON.stringify({
      teams: { T0EXAMPLE02: { token: "xoxc-NEW", name: "Acme", url: "https://acme.slack.com/" } },
    })
    await answerCredExtraction(ws, { config: rotated })

    expect(center.getCreds("T0EXAMPLE02")).toMatchObject({ token: "xoxc-NEW", fresh: true })
    expect(onCredsStuck).not.toHaveBeenCalled()
  })

  it("signals onCredsStuck when the re-extract reads the SAME stale token (t099)", async () => {
    const onCreds = vi.fn()
    const onCredsStuck = vi.fn()
    const { center } = makeCenter({ onCreds, onCredsStuck, onSlackSignal: vi.fn() })
    await center.reconcile([slackTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    await answerCredExtraction(ws)

    center.markCredsStale("T0EXAMPLE02", "invalid_auth")
    await Promise.resolve()
    await answerCredExtraction(ws) // same LOCAL_CONFIG → same token, still stale

    expect(onCredsStuck).toHaveBeenCalledWith("T0EXAMPLE02")
    // A known-bad token is not marked fresh — the health surface stays degraded.
    expect(center.getCreds("T0EXAMPLE02")?.fresh).toBe(false)
  })

  it("refreshCreds resolves false when no live Slack socket exists", async () => {
    const { center } = makeCenter({ onCreds: vi.fn() })
    expect(await center.refreshCreds()).toBe(false)
  })
})

describe("teams messaging-cred mint (t127)", () => {
  it("mints creds over a live Teams tab: bearer dump → authz → record + onTeamsCreds", async () => {
    const onTeamsCreds = vi.fn()
    const { center } = makeCenter({ onTeamsCreds })
    await center.reconcile([teamsTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    await answerTeamsMint(ws, { tid: "T-A", oid: "U-A", skypeToken: "skype-A" })

    const rec = center.getTeamsCreds("T-A")
    expect(rec).toMatchObject({
      tenant: "T-A",
      userId: "U-A",
      skypeToken: "skype-A",
      chatServiceBase: "https://apac.ng.msg.teams.microsoft.com",
      trouterUrl: "https://trouter.example/",
      fresh: true,
      lastError: null,
    })
    expect(rec?.bearer).toContain(".") // the JWT bearer is stored server-side (v1)
    expect(onTeamsCreds).toHaveBeenCalledWith(expect.objectContaining({ tenant: "T-A" }))
    expect(center.listTeamsCreds()).toHaveLength(1)
  })

  it("does NOT extract Teams creds when onTeamsCreds is absent (Electron structural stub)", async () => {
    const { center } = makeCenter() // no onTeamsCreds
    await center.reconcile([teamsTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    // No mint eval (only the capture-script injection) should carry the MSAL dump expression.
    const dump = ws.sent.find(
      (m: any) =>
        m.method === "Runtime.evaluate" && String(m.params?.expression).includes("accesstoken"),
    )
    expect(dump).toBeUndefined()
    expect(center.listTeamsCreds()).toEqual([])
  })

  it("marks creds stale on a 401 authz (bearer itself stale) without a record when new", async () => {
    const onTeamsCreds = vi.fn()
    const { center } = makeCenter({ onTeamsCreds })
    await center.reconcile([teamsTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    await answerTeamsMint(ws, { authzError: "invalid_auth" })
    expect(onTeamsCreds).not.toHaveBeenCalled()
    expect(center.listTeamsCreds()).toEqual([])
  })

  it("markTeamsCredsStale flips fresh→false then re-mints over the live socket (re-authz)", async () => {
    const onTeamsCreds = vi.fn()
    const { center } = makeCenter({ onTeamsCreds })
    await center.reconcile([teamsTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    await answerTeamsMint(ws, { tid: "T-A", skypeToken: "skype-OLD" })

    const stalePromise = center.markTeamsCredsStale("T-A", "invalid_auth")
    expect(center.getTeamsCreds("T-A")).toMatchObject({ fresh: false, lastError: "invalid_auth" })
    // The re-mint runs over the same socket — answer its fresh authz with a rotated token.
    await answerTeamsMint(ws, { tid: "T-A", skypeToken: "skype-NEW" })
    await stalePromise
    expect(center.getTeamsCreds("T-A")).toMatchObject({ skypeToken: "skype-NEW", fresh: true })
  })

  it("runInTeamsPage executes an in-page expression over a live Teams tab and returns its value", async () => {
    const onTeamsCreds = vi.fn()
    const { center } = makeCenter({ onTeamsCreds })
    await center.reconcile([teamsTarget()])
    const ws = FakeWs.instances[0]
    ws.open()
    await answerTeamsMint(ws)

    const p = center.runInTeamsPage("fetchConversations()")
    await Promise.resolve()
    const evalSend = [...ws.sent]
      .reverse()
      .find(
        (m: any) =>
          m.method === "Runtime.evaluate" &&
          String(m.params?.expression).includes("fetchConversations"),
      )
    ws.reply(evalSend.id, { result: { value: { conversations: [{ id: "19:x@thread.v2" }] } } })
    expect(await p).toEqual({ conversations: [{ id: "19:x@thread.v2" }] })
  })

  it("runInTeamsPage returns null when no Teams tab is live", async () => {
    const { center } = makeCenter({ onTeamsCreds: vi.fn() })
    expect(await center.runInTeamsPage("x")).toBeNull()
  })
})

describe("slack hijack ↔ sweep handoff (t071)", () => {
  const slackT = (teamId: string) => ({
    id: `s-${teamId}`,
    type: "page" as const,
    url: `https://app.slack.com/client/${teamId}/C001`,
    webSocketDebuggerUrl: `ws://host/devtools/page/${teamId}`,
  })

  it("a hijack toast triggers a sweep (not a store write) when the sweep owns the workspace", async () => {
    const onSlackSignal = vi.fn()
    const { center } = makeCenter({ onSlackSignal })
    await center.reconcile([slackT("T111")])
    const ws = FakeWs.instances[0]
    ws.open()
    ws.notify({ id: "sn1", title: "@alice: hi" })
    expect(onSlackSignal).toHaveBeenCalledWith("T111")
    expect(center.list()).toHaveLength(0) // no store write — the sweep is authoritative
  })

  it("falls back to storing the hijack entry when the workspace sweep is disabled", async () => {
    const onSlackSignal = vi.fn()
    const { center } = makeCenter({ onSlackSignal })
    await center.reconcile([slackT("T222")])
    const ws = FakeWs.instances[0]
    ws.open()
    center.disableSweep("T222", "team_is_restricted")
    ws.notify({ id: "sn2", title: "@bob: hey", source: "Grid WS" })
    expect(onSlackSignal).not.toHaveBeenCalled()
    expect(center.list().map((e: any) => e.id)).toEqual(["sn2"]) // stored via hijack fallback
  })

  it("without onSlackSignal (Electron), slack toasts store as before", async () => {
    const { center } = makeCenter()
    await center.reconcile([slackT("T333")])
    const ws = FakeWs.instances[0]
    ws.open()
    ws.notify({ id: "sn3", title: "hi" })
    expect(center.list().map((e: any) => e.id)).toEqual(["sn3"])
  })

  // A fully-unsupported Grid member (sweep disabled) falls back to the hijack writing the
  // entry. That entry must bucket under the MERGED groupId (slack:{groupId}, t092) — using the
  // raw teamId would reintroduce the duplicate the Grid merge removes, since the org pseudo-
  // team's swept entry for the same shared channel uses the groupId key.
  it("hijack fallback stamps the merged groupId groupKey for a Grid member", async () => {
    const onSlackSignal = vi.fn()
    const { center } = makeCenter({ onSlackSignal, onCreds: vi.fn() })
    // A tab for the Grid member workspace (carries enterprise_id E0EXAMPLE01 in localConfig).
    const gridTab = {
      id: "s-grid",
      type: "page" as const,
      url: "https://app.slack.com/client/T0EXAMPLE01/C001",
      webSocketDebuggerUrl: "ws://host/devtools/page/grid",
    }
    await center.reconcile([gridTab])
    const ws = FakeWs.instances[0]
    ws.open()
    await answerCredExtraction(ws) // populates creds incl. T0EXAMPLE01 → enterpriseId
    center.disableSweep("T0EXAMPLE01", "team_is_restricted")
    ws.notify({ id: "g1", title: "@bob: hey", source: "Grid WS" })
    expect(onSlackSignal).not.toHaveBeenCalled()
    const stored = center.list().find((e: any) => e.id === "g1")
    expect(stored?.groupKey).toBe("slack:E0EXAMPLE01")
  })

  it("hijack fallback for a standalone team keys by its own teamId (byte-unchanged)", async () => {
    const onSlackSignal = vi.fn()
    const { center } = makeCenter({ onSlackSignal, onCreds: vi.fn() })
    await center.reconcile([slackTarget()]) // url team T0EXAMPLE02, no enterprise_id
    const ws = FakeWs.instances[0]
    ws.open()
    await answerCredExtraction(ws)
    center.disableSweep("T0EXAMPLE02", "team_is_restricted")
    ws.notify({ id: "g2", title: "@al: hi" })
    const stored = center.list().find((e: any) => e.id === "g2")
    expect(stored?.groupKey).toBe("slack:T0EXAMPLE02")
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

  it("removeMany drops only the listed ids and persists (t085)", async () => {
    const { center, saved } = await seeded()
    const before = saved.length
    center.removeMany(["a"])
    expect(center.list().map((e: any) => e.id)).toEqual(["b"])
    expect(saved.length).toBeGreaterThan(before)
  })

  it("removeMany with no matches is a no-op list", async () => {
    const { center } = await seeded()
    center.removeMany(["nope"])
    expect(center.list().map((e: any) => e.id)).toEqual(["b", "a"])
  })
})

describe("applySlackReadByUnread — restricted-path read-sync (t075/t092)", () => {
  // The swept entries carry the MERGED groupKey (slack:{groupId}), but the runner only knows
  // the concrete teamId for activation. Read-sync must match by the groupId the entries are
  // keyed with — otherwise an Enterprise Grid member workspace's badges never clear.
  const gridEntry = (over: Partial<any> = {}) => ({
    id: `slack:E0EXAMPLE01:${(over as any).channelId || "C1"}:${(over as any).slackTs || "1.0"}`,
    adapter: "slack",
    groupKey: "slack:E0EXAMPLE01", // merged groupId, not the concrete team
    team: "T0EXAMPLE01",
    title: "msg",
    channelId: "C1",
    slackTs: "1.0",
    ts: 1000,
    ...over,
  })

  it("marks a merged-groupKey entry read when called with the groupId", () => {
    const { center } = makeCenter()
    center.ingestSlackEntry(gridEntry())
    expect(center.unreadCount()).toBe(1)
    // Called with the GROUP id (what the runner now passes), channel no longer unread.
    center.applySlackReadByUnread("E0EXAMPLE01", new Set())
    expect(center.unreadCount()).toBe(0)
  })

  it("keeps an entry unread while its channel is still in the unread-set", () => {
    const { center } = makeCenter()
    center.ingestSlackEntry(gridEntry())
    center.applySlackReadByUnread("E0EXAMPLE01", new Set(["C1"]))
    expect(center.unreadCount()).toBe(1)
  })

  it("does not touch a different group's entries", () => {
    const { center } = makeCenter()
    center.ingestSlackEntry(gridEntry())
    center.applySlackReadByUnread("E_OTHER", new Set())
    expect(center.unreadCount()).toBe(1)
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

// A socket that never reaches OPEN — models a hung CONNECTING side-channel.
class HungWs extends FakeWs {
  readyState = 0
}

describe("reconcile — reap hung side-channel (t096, P3)", () => {
  it("reaps a non-OPEN socket on a still-live target past the stale window and re-attaches", async () => {
    const { center, setNow } = makeCenter({ WebSocketCtor: HungWs as any })
    setNow(1_000)
    await center.reconcile([teamsTarget()])
    expect(FakeWs.instances).toHaveLength(1)
    const hung = FakeWs.instances[0]

    setNow(1_000 + 15_000 + 1) // past SIDECHANNEL_STALE_MS
    await center.reconcile([teamsTarget()])

    expect(hung.closed).toBe(true)
    expect(FakeWs.instances).toHaveLength(2) // re-attached
  })

  it("does not reap a freshly-attached non-OPEN socket within the stale window", async () => {
    const { center, setNow } = makeCenter({ WebSocketCtor: HungWs as any })
    setNow(1_000)
    await center.reconcile([teamsTarget()])

    setNow(1_000 + 5_000) // before the stale threshold
    await center.reconcile([teamsTarget()])

    expect(FakeWs.instances).toHaveLength(1)
    expect(FakeWs.instances[0].closed).toBe(false)
  })

  it("does not reap an OPEN socket on a live target", async () => {
    const { center, setNow } = makeCenter() // default FakeWs is OPEN (readyState 1)
    setNow(1_000)
    await center.reconcile([teamsTarget()])
    setNow(1_000 + 60_000)
    await center.reconcile([teamsTarget()])
    expect(FakeWs.instances).toHaveLength(1)
    expect(FakeWs.instances[0].closed).toBe(false)
  })
})

describe("side-channel cdpCall reject-on-close (t096, P4)", () => {
  it("rejects an in-flight cred extraction when the socket closes — no creds, no hang", async () => {
    const onCreds = vi.fn()
    const { center } = makeCenter({ onCreds })
    await center.reconcile([slackTarget()])
    const ws = FakeWs.instances[0]
    ws.open() // fires extractSlackCreds → sends the localConfig read, awaits its reply

    ws.close() // reply never comes — drop() must reject the pending call
    await Promise.resolve()
    await Promise.resolve()

    expect(center.listCreds()).toEqual([])
    expect(onCreds).not.toHaveBeenCalled()
  })
})
