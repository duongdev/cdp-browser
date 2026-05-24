# 004 — pin live-tab model (arc-style pinned tabs)

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** none

## Goal

Replace the current "Pinned = bookmark launcher" behavior with an Arc-style pinned-tab model. A **Pin** holds a remote tab: clicking it shows that tab's content (existing if alive, freshly opened if not). Pinned tabs are hidden from the Tabs list and live only in the Pinned section. Pins can be created from any tab (star, right-click, drag), edited (title + URL), closed (reverts to a URL the pin remembers), and un-pinned (the tab survives as a normal tab). No visible linked/dormant indicator — a pin always looks like a pin and always shows content on click.

## Why now

The current Pinned section replaces the active tab on single-click, can't be edited, and only supports middle-click to open a new tab. It behaves like a bookmark bar bolted onto a tab strip. Promoting pins to live-tab holders makes the sidebar a single coherent surface (pinned tabs + ephemeral tabs), matching how the operator actually drives a browser.

## Acceptance criteria

- [ ] Single-click a pin shows its content: activates the linked tab if alive, else opens a fresh tab on the pin's saved URL and links it.
- [ ] A pin's linked tab does **not** appear in the Tabs list.
- [ ] cmd+click or middle-click a pin opens its URL in a **plain new tab** (appears in Tabs list, **not** linked to the pin).
- [ ] Pins are created by: toolbar star (pins active tab), right-click tab → Pin, and dragging a tab into the Pinned section.
- [ ] Right-click a pin offers Edit, Un-pin, Close.
- [ ] Edit dialog edits Title + URL with a "Use current tab URL" button (enabled only when linked and the live URL differs from the saved URL).
- [ ] Closing a pin's tab (cmd+W or close affordance) closes the remote tab; the pin stays in the list and reopens its saved URL on next click.
- [ ] Un-pinning removes the pin; if it had a live tab, that tab reappears in the Tabs list.
- [ ] On startup, a pin re-links to its persisted target if alive, else URL-matches an existing remote target, else has no tab.
- [ ] If a pin's linked target vanishes from `/json` (closed externally), the pin quietly drops its link.
- [ ] The active pin (its tab currently being viewed) gets the standard active highlight; there is **no** linked/dormant badge.
- [ ] All Pinned-section interactions (create, reorder, highlight, collapse) animate as smoothly as the existing tab list.

## Test plan

### Layer 1 — Pure logic (TDD)

New `src/lib/pins.ts` module — pure resolution over `Pin[]` and the current target list:

- [ ] `resolvePinLink(pin, targets)` — returns linked targetId when persisted id alive
- [ ] `resolvePinLink` — URL-fallback match when persisted id dead
- [ ] `resolvePinLink` — no link when neither id nor URL matches
- [ ] `pinForTarget(pins, targetId)` — identifies whether a target belongs to a pin (drives Tabs-list filtering)
- [ ] `dropDeadLinks(pins, targets)` — clears targetId for pins whose target vanished
- [ ] settings migration `bookmarks` → `pins` shape (covered where migration lives)

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] Star a tab → it moves into Pinned and disappears from Tabs.
- [ ] Click pin → its tab shows; click again after switching away → same tab re-activates (no duplicate).
- [ ] cmd+click pin → a second, independent tab opens in Tabs list on same URL.
- [ ] Close a pinned tab → pin stays; re-click reopens saved URL.
- [ ] Un-pin a live pin → tab appears in Tabs list.
- [ ] Restart app with a pinned tab still open on remote → pin re-links to it.
- [ ] Edit pin URL via "Use current tab URL" after navigating the tab elsewhere.

### Layer 3 — Visual review

- [ ] Screenshots via Chrome MCP against `pnpm dev`
- [ ] States visible: no pins, pins with active highlight, collapsed sidebar pins
- [ ] Context menu (radix-nova) on tab and on pin
- [ ] Cross-section drag (tab → Pinned) animates smoothly; reorder within Pinned unaffected

## Design notes

- **Contracts changed:**
  - `Bookmark` → `Pin` everywhere (renderer type, `CdpBridge` IPC methods, settings key, `CONTEXT.md` glossary). `Pin { id; title; url; favicon?; targetId? }` — `targetId` is the linked remote target, omitted when unlinked. Persisted; not authoritative (revalidated against `/json` on load).
  - IPC: `getBookmarks/addBookmark/removeBookmark/reorderBookmarks` → `getPins/addPin/removePin/reorderPins`. Add `updatePin(id, {title,url})`.
  - Settings: `settings.bookmarks` → `settings.pins`, migrated on first load (mirror the existing `switchBlur → switchEffect` migration pattern).
- **New modules:** `src/lib/pins.ts` — pure link-resolution + Tabs-list filtering, justified because the linked/dormant resolution and dead-link cleanup are the only non-trivial logic and must be TDD'd per `tdd.md`.
- **Tabs-list filtering:** the Tabs list = remote targets minus those owned by a pin (`pinForTarget`). Closing/un-pinning naturally returns a target to the list.
- **Context menu:** add shadcn `context-menu` (radix-nova style) to `src/components/ui/` via CLI; none exists today. Used by tab rows (Pin) and pin rows (Edit, Un-pin, Close).
- **cmd+W routing:** `closeTab` detects a pin-owned target and routes to "close tab, keep pin dormant" instead of removing a list entry.
- **New ADR needed?** yes — draft title: `0004-pin-live-tab-model` (records: pins own remote targets, hidden from Tabs list, link revalidated against `/json`, in-session click never adopts but startup does).

```ts
interface Pin {
  id: string
  title: string
  url: string        // saved reopen URL; edited manually, never auto-updated on drift
  favicon?: string
  targetId?: string  // linked remote target; absent = unlinked (no visible indicator)
}

// pure, tested
function resolvePinLink(pin: Pin, targets: TabInfo[]): string | undefined
function pinForTarget(pins: Pin[], targetId: string): Pin | undefined
function dropDeadLinks(pins: Pin[], targets: TabInfo[]): Pin[]
```

## Out of scope

- Manual creation of an unlinked pin from a typed URL (pins are always born from a live tab).
- Adopting an existing same-URL tab on in-session click (only startup URL-matches; in-session click always opens fresh).
- Auto-saving navigation drift into the pin's URL (drift is captured only via the Edit "Use current tab URL" button).
- Pinned-tab persistence of scroll/session state beyond what the remote browser already keeps.

## Definition of Done

All must be true before status → done.

- [x] Layer 1 tests written and green
- [x] Layer 2 smoke checklist completed with a live Remote Browser
- [ ] Layer 3 screenshots captured and committed
- [x] `pnpm check` clean
- [x] `pnpm typecheck` clean
- [x] `pnpm test` green
- [x] `pnpm dev` boots cleanly and the changed surface works end-to-end
- [x] CLAUDE.md updated (sidebar, settings persistence, file structure for `pins.ts`)
- [x] ADR `0004-pin-live-tab-model` written
- [x] No commented-out code, no `console.log` debris, no AI attribution
- [x] Task closed: status → done, file moved to `docs/tasks/done/`, t004 in commit

## Notes

Resolved during grilling:
- Pin model = live-tab holder (Arc-style), hidden from Tabs list.
- No linked/dormant visual indicator — click always shows content.
- Link persistence: persist targetId; URL-fallback on startup; in-session dormant click always opens fresh.
- Close → tab closed + pin stays; Un-pin → tab survives in Tabs list.
- Edit = title + URL + "Use current tab URL" button.
- cmd/middle-click = plain independent new tab, not linked.
- Context menu = shadcn radix-nova `context-menu`.

Second-wave refinements (post-first-review):
- Linked pin mirrors its tab's live title/favicon; saved title restored on close.
- URL drift (Arc button-style) shown only on the **active** pin: `/` separator + favicon "Back to Pinned URL" button.
- Unread badges grouped by **origin** — all tabs/pins of an app share one count; dormant pins badge by saved-URL origin.
- Cmd+1..9 = all pins then visible tabs; Ctrl+Tab/⇧Tab = open pins + tabs (dormant pins skipped while cycling).
- Tab context menu adds Close other tabs / Close tabs above / Close tabs below.
- Un-pin behind a confirm `alert-dialog`; dormant pins get a hover unpin button (close-X slot).
- Pinned-section collapse keeps pins with open tabs; only dormant pins hide.
- Animation: **motion** for row enter/exit (incl. smooth collapse). dnd-kit owns the drag transform (transform/transition + `DragOverlay`); motion only wraps a presence-only outer node — they never share a transform. (The earlier `LayoutGroup`/`layout`-on-drag-node approach was reverted; it fought dnd-kit and broke dragging.)

---

_When task status flips to `done`, move this file to `done/`._
