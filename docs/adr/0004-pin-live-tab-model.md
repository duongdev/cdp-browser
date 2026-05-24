# ADR-0004: Pins hold live tabs (Arc-style)

- **Status:** Accepted
- **Date:** 2026-05-24

## Context

The Pinned section was a read-only bookmark bar: single-click navigated the
**active** tab to the bookmark's URL (clobbering whatever was open), there was no
edit, and the only way to open one elsewhere was a middle-click. It behaved like
a launcher bolted onto the tab strip, not like the pinned tabs of a real browser.

We want pins to behave like Arc's pinned tabs: a pin *holds* a tab, clicking it
shows that tab's content, and the pinned tab lives in the Pinned section rather
than cluttering the ephemeral Tabs list.

## Decision

A **Pin** is a persisted `{ id, title, url, favicon?, targetId? }`. `targetId`
names the live remote target the pin currently holds; absent means unlinked.

- **One pin, one tab.** A pin's linked target is **hidden from the Tabs list** —
  the Tabs list is the reconciled remote targets minus those any pin holds
  (`pinForTarget`).
- **Click shows content.** Plain click activates the linked tab if alive; if not,
  it opens a fresh tab on the saved URL and links it. There is **no** dormant/linked
  visual indicator — a pin always looks like a pin. Cmd/middle-click opens the URL
  in an independent throwaway tab, unlinked.
- **Create from a live tab only** — toolbar star, right-click tab → Pin, or drag a
  tab into the Pinned section. There is no "add a dormant pin from a typed URL".
- **Close vs un-pin.** Closing a pin's tab closes the remote target and the pin
  reverts to unlinked but stays in the list. Un-pinning removes the pin; any live
  tab survives and reappears in the Tabs list.
- **Link lifecycle is pure.** `src/lib/pins.ts` decides links: `resolvePinLink`
  (persisted id, else URL match, else none) runs on startup; `dropDeadLinks`
  prunes a pin whose target vanished; `pinForTarget` drives the filtering. All
  effects (opening/closing tabs, persistence, IPC) live in `app.tsx` / main.
- **In-session clicks never adopt.** URL-matching an existing tab happens only at
  startup (restoring links across a restart). A click on an unlinked pin always
  opens fresh, so behavior is deterministic during a session.

Renaming followed the concept: `Bookmark` → `Pin` across the renderer type, the
IPC bridge (`getPins`/`addPin`/`updatePin`/`removePin`/`reorderPins`), and the
settings store. Legacy `settings.bookmarks` is migrated to `settings.pins` on
first load, mirroring the `switchBlur → switchEffect` migration.

## Consequences

- The sidebar becomes one coherent surface: durable pinned tabs above, ephemeral
  tabs below, with no duplicate rows.
- Link resolution is unit-testable in isolation (`pins.test.ts`); the renderer
  only wires effects to it.
- `targetId` is persisted but treated as a hint — it is always revalidated against
  the live `/json` target list, because remote target ids do not survive a remote
  browser restart (URL fallback covers that case).
- More renderer state to keep coherent: the Tabs list, the active-tab highlight,
  and the pin links must all agree. Centralising the filtering in `pinForTarget`
  and pruning in `dropDeadLinks` keeps that in one place.
- Cross-section drag (tab → Pinned) requires a single `DndContext` spanning both
  lists; the dragged row can clip at the Tabs scroll boundary, but the drop still
  registers via collision detection.

## Alternatives

- **Keep pins as bookmarks, just add edit + open-in-new-tab.** Simpler and less
  stateful, but never delivers the "click a pin, see it" feel that motivated the
  change.
- **Show the pinned tab in both the Pinned section and the Tabs list.** Keeps the
  Tabs list a pure mirror of remote targets (no filtering), but duplicates rows and
  muddies "where does this tab live".
- **Adopt an existing same-URL tab on every click.** Avoids duplicate tabs, but
  makes in-session clicks non-deterministic (sometimes adopt, sometimes open). We
  restricted adoption to startup only.
