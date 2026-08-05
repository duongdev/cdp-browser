import { describe, expect, it, vi } from "vitest"
// @ts-expect-error -- shared CJS core, no types (ADR-0008)
import { applyModelLock, fetchModelCatalogue, fetchSessionModel } from "./hermes-model.js"

/**
 * The panel stores its model pick on chat-server and the selector renders that value. On the
 * Hermes path nothing forwarded it, so the label and the model that actually answered were
 * unrelated: the picker read `glm/glm-5.1` while the turn ran `hermes-default`. A wrong label
 * is worse than a missing one, because it is trusted.
 *
 * A LOCK is used rather than a per-request `model` field. Measured against the live gateway:
 * once a session carries a lock, a per-request model is silently ignored — so forwarding
 * per-request would work on a fresh session and quietly stop working after the first switch.
 */

const BFF = "http://chat-server:7788"

function jsonFetch(body: unknown, ok = true) {
  return vi.fn(async (_url: string) => ({ ok, status: ok ? 200 : 500, json: async () => body }))
}

describe("fetchModelCatalogue", () => {
  it("returns the id marked default", async () => {
    // The default is env-driven (LLM_MODEL on the deployment, exposed via /models). One source
    // of truth: change the deployment, every consumer follows.
    const fetchImpl = jsonFetch({
      models: [
        { id: "glm/glm-5.1", default: false },
        { id: "fwd-sonnet", default: true },
      ],
    })
    expect((await fetchModelCatalogue(BFF, fetchImpl)).defaultId).toBe("fwd-sonnet")
    expect(fetchImpl.mock.calls[0][0]).toBe(`${BFF}/api/chat/assistant/models`)
  })

  it("returns every offered id", async () => {
    // The list is what tells a real switch apart from the gateway's own internal model name.
    const fetchImpl = jsonFetch({ models: [{ id: "a" }, { id: "b", default: true }] })
    expect((await fetchModelCatalogue(BFF, fetchImpl)).ids).toEqual(["a", "b"])
  })

  it("returns empty when nothing is marked default", async () => {
    const fetchImpl = jsonFetch({ models: [{ id: "a" }, { id: "b" }] })
    expect((await fetchModelCatalogue(BFF, fetchImpl)).defaultId).toBe("")
  })

  it("returns empty rather than throwing when the catalogue is unreachable", async () => {
    // No catalogue means "no opinion" — the session keeps whatever it has. Throwing would fail
    // the turn over a side lookup.
    const boom = vi.fn(async () => {
      throw new Error("down")
    })
    expect(await fetchModelCatalogue(BFF, boom)).toEqual({ ids: [], defaultId: "" })
    expect(await fetchModelCatalogue(BFF, jsonFetch({}, false))).toEqual({ ids: [], defaultId: "" })
  })
})

describe("fetchSessionModel", () => {
  it("reads the session's stored pick", async () => {
    const fetchImpl = jsonFetch({ session: { id: "s1", model: "glm/glm-4.7" } })
    expect(await fetchSessionModel(BFF, "s1", fetchImpl)).toEqual({ model: "glm/glm-4.7" })
  })

  it("returns empty for a session with no pick", async () => {
    // Empty means "use the deployment default", NOT "use whatever ran last" — otherwise a new
    // session would silently inherit an unrelated session's model.
    const fetchImpl = jsonFetch({ session: { id: "s1", model: null } })
    expect(await fetchSessionModel(BFF, "s1", fetchImpl)).toEqual({ model: "" })
  })

  it("encodes the session id", async () => {
    const fetchImpl = jsonFetch({ session: {} })
    await fetchSessionModel(BFF, "a/b", fetchImpl)
    expect(new URL(fetchImpl.mock.calls[0][0]).pathname).toBe(
      "/api/chat/assistant/sessions/a%2Fb/messages",
    )
  })
})

describe("applyModelLock", () => {
  const client = (ok: boolean, sessionModel = "") => ({
    lockModel: vi.fn(async (_s: string, _m: string) => ok),
    sessionModel: vi.fn(async (_s: string) => sessionModel),
  })
  // The panel's real catalogue. `announce` is only true for a move between two ids in here.
  const CATALOGUE = ["glm/glm-5.1", "glm/glm-5-turbo", "glm/glm-4.7", "fwd-sonnet"]
  // `log` is optional in the module; typed here so each call site need not repeat it.
  const lock = (args: Record<string, unknown>) =>
    applyModelLock(args as Parameters<typeof applyModelLock>[0])

  it("locks when the wanted model differs", async () => {
    const c = client(true)
    const out = await lock({
      client: c,
      sessionId: "s1",
      wanted: "glm/glm-5.1",
      previous: "fwd-sonnet",
    })
    expect(c.lockModel).toHaveBeenCalledWith("s1", "glm/glm-5.1")
    expect(out).toMatchObject({ changed: true, model: "glm/glm-5.1", from: "fwd-sonnet" })
  })

  it("does not re-lock a model already in place", async () => {
    // A redundant POST per turn is an extra round-trip and an extra thing that can fail, on the
    // hot path of every message.
    const c = client(true)
    const out = await lock({
      client: c,
      sessionId: "s1",
      wanted: "fwd-sonnet",
      previous: "fwd-sonnet",
    })
    expect(c.lockModel).not.toHaveBeenCalled()
    expect(out.changed).toBe(false)
  })

  it("asks the gateway for the previous model when it has no memory of the session", async () => {
    // After a proxy restart the in-process cache is empty for EVERY session. Treating that as
    // "nothing was locked" would announce a switch on a thread where nothing changed. The
    // gateway persists the lock, so it holds the real answer.
    const c = client(true, "glm/glm-5.1")
    const out = await lock({
      client: c,
      sessionId: "s1",
      wanted: "glm/glm-5.1",
      previous: null,
      catalogue: CATALOGUE,
    })
    expect(c.sessionModel).toHaveBeenCalledWith("s1")
    expect(c.lockModel).not.toHaveBeenCalled()
    expect(out).toMatchObject({ changed: false, announce: false })
  })

  it("locks a first-time session without announcing it", async () => {
    // The gateway reports its own virtual model name for an unlocked session. That is not a
    // value the user picked, so "Model changed from hermes-agent" would be noise on turn one of
    // every new conversation.
    const c = client(true, "hermes-agent")
    const out = await lock({
      client: c,
      sessionId: "s1",
      wanted: "fwd-sonnet",
      previous: null,
      catalogue: CATALOGUE,
    })
    expect(c.lockModel).toHaveBeenCalledWith("s1", "fwd-sonnet")
    expect(out.changed).toBe(true)
    expect(out.announce).toBe(false)
  })

  it("announces a switch between two models the panel offers", async () => {
    const out = await lock({
      client: client(true),
      sessionId: "s1",
      wanted: "glm/glm-4.7",
      previous: "fwd-sonnet",
      catalogue: CATALOGUE,
    })
    expect(out).toMatchObject({ changed: true, announce: true, from: "fwd-sonnet" })
  })

  it("does not report a change when the gateway refuses the lock", async () => {
    // Reporting a refused lock as changed would put a marker row in the thread announcing a
    // switch that did not happen — the exact lying-label bug being fixed.
    const logs: string[] = []
    const out = await lock({
      client: client(false),
      sessionId: "s1",
      wanted: "glm/glm-5.1",
      previous: "fwd-sonnet",
      log: (l: string) => logs.push(l),
    })
    expect(out.changed).toBe(false)
    expect(out.announce).toBe(false)
    expect(out.failed).toBe(true)
    expect(out.model).toBe("fwd-sonnet")
    expect(logs.join()).toContain("rejected")
  })

  it("survives a throwing client", async () => {
    const out = await lock({
      client: {
        lockModel: async () => {
          throw new Error("gateway down")
        },
      },
      sessionId: "s1",
      wanted: "glm/glm-5.1",
      previous: null,
    })
    expect(out.changed).toBe(false)
    expect(out.failed).toBe(true)
  })

  it("does nothing without a wanted model", async () => {
    const c = client(true)
    const out = await lock({ client: c, sessionId: "s1", wanted: "", previous: null })
    expect(c.lockModel).not.toHaveBeenCalled()
    expect(out.changed).toBe(false)
  })

  it("logs every switch it makes", async () => {
    // Dustin asked to be able to SEE the switch happen, not infer it from behaviour.
    const logs: string[] = []
    await lock({
      client: client(true),
      sessionId: "s1",
      wanted: "glm/glm-4.7",
      previous: "fwd-sonnet",
      log: (l: string) => logs.push(l),
    })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain("fwd-sonnet")
    expect(logs[0]).toContain("glm/glm-4.7")
  })
})
