// Notification activation dispatch — the single extension point an adapter plugs a
// deep-open into. A captured notification may carry an `activate` tagged union (semantic
// ids only — never DOM selectors); this module maps each variant to a Remote Page
// *intention descriptor* (a method name + a string arg). The effect layer (app.tsx)
// executes the intention by calling `page[method](arg)` after activating the owning Tab.
//
// Pure: no IPC, no DOM, no Remote Page reference. Adding a third adapter's activation is
// one new `ActivateIntent` variant + one registry entry — no edit to the dispatch loop.

/** What a notification asks for when clicked. Closed and small; an unknown `type`
 *  degrades to Tab-only activation (handled by `resolveActivation` returning null), so an
 *  older renderer tolerates a newer capture script. Semantic ids only — no selectors. */
export type ActivateIntent =
  | { type: "spa-link"; url: string } // outlook: deep-open a message via navigateSpa
  | { type: "thread"; id: string } // teams chats: open the conversation by thread id

/** A Remote Page deep-open call, named declaratively. The effect layer dispatches it as
 *  `page[method](arg)`; only Remote Page methods that take a single string arg appear. */
export interface RemotePageIntention {
  method: "navigateSpa" | "openTeamsThread"
  arg: string
}

/** Maps one activate variant to a Remote Page intention. Returns null when the variant
 *  carries no actionable target (degrade to Tab-only) — it must never throw. */
export type ActivationHandler = (a: ActivateIntent) => RemotePageIntention | null

export type ActivationRegistry = Record<string, ActivationHandler>

/** The built-in registry covering today's two adapters. Returns a fresh object each call
 *  so callers can extend it (`{ ...createActivationRegistry(), slack: … }`) without
 *  mutating a shared instance. */
export function createActivationRegistry(): ActivationRegistry {
  return {
    "spa-link": (a) =>
      a.type === "spa-link" && a.url ? { method: "navigateSpa", arg: a.url } : null,
    thread: (a) => (a.type === "thread" && a.id ? { method: "openTeamsThread", arg: a.id } : null),
  }
}

/** Resolve a notification's activate intent to a Remote Page intention, or null when the
 *  entry has no activate, an unregistered type, or a handler that opts out. Null means
 *  "activate the owning Tab only" — the caller does the Tab activation regardless. */
export function resolveActivation(
  registry: ActivationRegistry,
  activate: ActivateIntent | null | undefined,
): RemotePageIntention | null {
  if (!activate || typeof activate.type !== "string") return null
  const handler = registry[activate.type]
  return handler ? handler(activate) : null
}

/** Back-compat: derive an activate intent from the legacy `targetEntity` shape for
 *  notifications captured before the `activate` field existed (or any payload missing it).
 *  Mirrors the pre-t028 click logic — Outlook's per-message `deepLink` → spa-link, a Teams
 *  "chats" thread id → thread. Returns null when the entity carries no openable target.
 *  Used as a fallback: `entry.activate ?? deriveLegacyActivate(entry.targetEntity)`. */
export function deriveLegacyActivate(targetEntity: unknown): ActivateIntent | null {
  if (!targetEntity || typeof targetEntity !== "object") return null
  const te = targetEntity as { deepLink?: unknown; type?: unknown; id?: unknown }
  if (typeof te.deepLink === "string" && te.deepLink) return { type: "spa-link", url: te.deepLink }
  if (te.type === "chats" && typeof te.id === "string" && te.id.startsWith("19:"))
    return { type: "thread", id: te.id }
  return null
}
