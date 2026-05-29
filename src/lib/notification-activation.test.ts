import { describe, expect, it } from "vitest"
import {
  type ActivateIntent,
  type ActivationHandler,
  createActivationRegistry,
  deriveLegacyActivate,
  resolveActivation,
} from "./notification-activation"

describe("resolveActivation (default registry)", () => {
  const registry = createActivationRegistry()

  it("maps spa-link to a navigateSpa intention", () => {
    const a: ActivateIntent = { type: "spa-link", url: "https://outlook.office.com/mail/id/X" }
    expect(resolveActivation(registry, a)).toEqual({
      method: "navigateSpa",
      arg: "https://outlook.office.com/mail/id/X",
    })
  })

  it("maps thread to an openTeamsThread intention", () => {
    const a: ActivateIntent = { type: "thread", id: "19:abc@thread.v2" }
    expect(resolveActivation(registry, a)).toEqual({
      method: "openTeamsThread",
      arg: "19:abc@thread.v2",
    })
  })

  it("yields null when there is no activate (Tab-only activation)", () => {
    expect(resolveActivation(registry, undefined)).toBeNull()
    expect(resolveActivation(registry, null)).toBeNull()
  })

  it("yields null for an unregistered type without throwing (older renderer tolerates newer capture)", () => {
    const a = { type: "channel", id: "C123" } as unknown as ActivateIntent
    expect(() => resolveActivation(registry, a)).not.toThrow()
    expect(resolveActivation(registry, a)).toBeNull()
    // (the unknown-type path is exercised; existing handlers are not consulted)
  })

  it("yields null for a handler that returns null for its own payload", () => {
    // spa-link with a missing url degrades to Tab-only, never throws.
    const a = { type: "spa-link" } as unknown as ActivateIntent
    expect(resolveActivation(registry, a)).toBeNull()
  })
})

describe("registry extensibility (zero core edit)", () => {
  it("dispatches a newly registered type without touching existing handlers", () => {
    const base = createActivationRegistry()
    // A hypothetical future variant — cast through unknown since ActivateIntent is closed.
    const channelHandler: ActivationHandler = (a) => {
      const c = a as unknown as { type: string; id: string }
      return c.type === "channel" ? { method: "navigateSpa", arg: `slack://${c.id}` } : null
    }
    const registry = { ...base, channel: channelHandler }

    // The new type dispatches.
    expect(
      resolveActivation(registry, { type: "channel", id: "C9" } as unknown as ActivateIntent),
    ).toEqual({
      method: "navigateSpa",
      arg: "slack://C9",
    })
    // Existing handlers are unchanged.
    expect(resolveActivation(registry, { type: "thread", id: "19:z@thread.v2" })).toEqual({
      method: "openTeamsThread",
      arg: "19:z@thread.v2",
    })
    // The base registry is not mutated by extension.
    expect("channel" in base).toBe(false)
  })
})

describe("deriveLegacyActivate (back-compat for pre-activate notifications)", () => {
  it("derives spa-link from an Outlook targetEntity deepLink", () => {
    expect(deriveLegacyActivate({ deepLink: "https://outlook.office.com/mail/id/X" })).toEqual({
      type: "spa-link",
      url: "https://outlook.office.com/mail/id/X",
    })
  })

  it("derives thread from a Teams chats targetEntity", () => {
    expect(deriveLegacyActivate({ type: "chats", id: "19:abc@thread.v2" })).toEqual({
      type: "thread",
      id: "19:abc@thread.v2",
    })
  })

  it("returns null for non-openable / absent entities (degrade to Tab-only)", () => {
    expect(deriveLegacyActivate(null)).toBeNull()
    expect(deriveLegacyActivate(undefined)).toBeNull()
    expect(deriveLegacyActivate("nope")).toBeNull()
    expect(deriveLegacyActivate({ type: "calls", id: "19:meeting_x@thread.v2" })).toBeNull()
    expect(deriveLegacyActivate({ type: "chats", id: "48:notes" })).toBeNull()
    expect(deriveLegacyActivate({})).toBeNull()
  })

  it("composes as a fallback after a present activate intent", () => {
    // The renderer uses `entry.activate ?? deriveLegacyActivate(entry.targetEntity)`.
    const registry = createActivationRegistry()
    const legacyOnly = deriveLegacyActivate({ type: "chats", id: "19:legacy@thread.v2" })
    expect(resolveActivation(registry, legacyOnly)).toEqual({
      method: "openTeamsThread",
      arg: "19:legacy@thread.v2",
    })
  })
})
