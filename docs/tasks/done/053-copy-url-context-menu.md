# 053 — copy address action in tab + pin context menus

- **Status:** done
- **Mode:** HITL
- **Ring:** inner
- **Slice:** 4-table-stakes-latency
- **Depends on:** none
- **Blocks:** none

## Goal

Add a **Copy address** item to the CDP tab and pin context menus in the sidebar.
Selecting it writes the tab's (or pin's) URL to the system clipboard via
`navigator.clipboard.writeText` and confirms with a short toast. After this task,
a daily-driver on the iPad PWA can lift a tab/pin URL — to paste into a message, a
notes app, or the URL bar of another tab — without a keyboard or any text-selection
gymnastics on the canvas.

## Why now

Copying a URL is a baseline browser action, and on the touch surface it is
currently **impossible**: the address lives in the remote screencast (not selectable
text) and there is no menu affordance to lift it. The v0.1.0 inner ring is the
"would I want to use this on an iPad all day" gate (slice 4 — table-stakes), and
"share this link" is table stakes. It is a small, isolated UI add with no shared-core
or transport change, so it is a cheap inner-ring win that removes a sharp
keyboard-only edge before tagging v0.1.0.

## Acceptance criteria

- [ ] The **CDP tab** right-click / long-press context menu shows a **Copy address** item (with a copy icon), placed sensibly among the existing items (e.g. directly under **Pin**).
- [ ] The **pin** context menu shows the same **Copy address** item (e.g. above the **Edit** item).
- [ ] Selecting it writes the correct URL to the clipboard via `navigator.clipboard.writeText`: for a tab, the tab's current URL; for a pin, the **live linked tab's URL when the pin is linked and has drifted**, otherwise the pin's saved `url` (matches what the tooltip already shows: `linkedTab?.url || pin.url`).
- [ ] A success toast ("Address copied" or similar) fires after a successful copy; a failed/blocked clipboard write surfaces a non-crashing error toast (never throws into the render path).
- [ ] The item is **not shown** when there is no URL to copy (e.g. a brand-new/empty tab with no `url`) — or is disabled — so the menu never copies an empty string.
- [ ] No regression to the existing menu items (Edit / Close tab / Unpin on pins; Pin / Close / Close others-above-below on tabs) — same order, same handlers.
- [ ] Works under a coarse pointer: the item is reachable from a long-press-opened context menu on touch, not only right-click.

## Test plan

### Layer 1 — Pure logic (TDD)

The URL-to-copy selection is a one-liner (`linkedTab?.url || pin.url`) and the copy
itself is a browser API call, so there is **no new pure module** worth extracting
for a single call site. n/a — this task only touches renderer UI wiring (context-menu
items + a clipboard call + a toast); no `src/lib/` domain logic or shared-core is
added. If the URL-selection rule grows beyond the existing `linkedTab?.url || pin.url`
expression, extract a tiny pure helper and TDD it then — not now.

### Layer 2 — Manual smoke (CDP/IPC)

n/a — no main-process, IPC, `preload.js`, or `web/server.mjs` change. The clipboard
write is a pure renderer/browser call; no live Remote Browser is required to verify
the copy itself (a tab with any non-empty `url` exercises the path).

### Layer 3 — Visual review

Desktop-web via Chrome DevTools MCP against `pnpm dev` (or `pnpm web`) is acceptable
for everything except the iPad long-press gesture, which is **HITL** on a physical
iPad.

- [ ] Right-click a CDP tab → menu shows **Copy address**; selecting it puts the tab URL on the clipboard (verify by reading `navigator.clipboard.readText()` in the MCP console, or paste into the URL bar) and a success toast appears.
- [ ] Right-click a pin → menu shows **Copy address**; for a **drifted linked pin** it copies the live tab URL, for an unlinked/at-rest pin it copies the saved `pin.url`.
- [ ] Screenshot both menus open showing the new item (icon + label, correct position).
- [ ] HITL (physical iPad PWA): long-press a tab and a pin → context menu opens and **Copy address** is tappable with a 44pt+ touch target; paste confirms the URL landed. (Couch-mode finger reachability rolls up into the t018 gate.)

## Design notes

Pure renderer UI add inside `src/components/sidebar.tsx`. Two new
`ContextMenuItem`s — one in the pin menu (the `SortablePinItem` `ContextMenuContent`,
alongside Edit/Close/Unpin) and one in the CDP tab menu (the `SortableTabItem`
`ContextMenuContent`, alongside Pin/Close/Close-others). Each item's `onSelect`
resolves the URL (pin: `linkedTab?.url || pin.url`; tab: the tab's `url`), calls
`navigator.clipboard.writeText(url)`, and toasts via the existing `sonner` `toast`
already used in `app.tsx`. Reuse the existing `HugeiconsIcon` + `ContextMenuItem`
pattern and a HugeIcons copy glyph (e.g. `Copy01Icon`); follow the local-owned
shadcn **radix-nova** menu style — no new dependency.

- **Contracts changed:** none. No props/IPC/REST/store change. `SortablePinItem`
  already has `pin` + `linkedTab` in scope; `SortableTabItem` already has `tab`. The
  copy reads existing data — no new wiring up from `app.tsx`.
- **New modules:** none. (A pure URL-selection helper is intentionally *not* added —
  it would be a single-use abstraction; see code-quality "no abstractions for
  single-use code".)
- **New ADR needed?** no — a context-menu item is not an architectural decision.

```ts
// behavioral contract for each new item, not a file path
// pin:  copyTarget = linkedTab?.url || pin.url   // matches the tooltip's source of truth
// tab:  copyTarget = tab.url
// onSelect: copyTarget && navigator.clipboard.writeText(copyTarget)
//           .then(() => toast.success("Address copied"))
//           .catch(() => toast.error("Couldn't copy address"))
```

## Out of scope

- **Local tabs** (`SortableLocalItem`): Electron-only and feature-gated off on the
  web release surface; if cheap, mirror the same item there for parity, but it is not
  required for the web-PWA v0.1.0 gate and must not block. Keep the focus on CDP tabs +
  pins per the spec.
- A toolbar/URL-bar "copy current address" button — separate affordance, not this task.
- Copying anything other than the URL (title, markdown link, "copy as cURL", QR, etc.).
- A `?`-overlay / ⌘K palette entry for copy (the command palette is its own outer-ring
  task, t058).
- Any clipboard *paste*/open-from-clipboard flow.

## Definition of Done

All must be true before status → done.

- [ ] Layer 1 tests written and green (if pure logic was touched)
- [ ] Layer 2 smoke checklist completed with a live Remote Browser (if main.js/IPC touched)
- [ ] Layer 3 screenshots captured and committed (if UI touched)
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm dev` boots cleanly and the changed surface works end-to-end
- [ ] CLAUDE.md updated for any modified module
- [ ] ADR written if an architectural decision was made
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, tNNN in commit

## Notes

`navigator.clipboard.writeText` needs a secure context — fine for the PWA (HTTPS via
the portal / Tailscale Serve) and `localhost` in dev, but it can reject if the
document isn't focused or permission is denied; the `.catch` → error-toast keeps that
from becoming a stuck/silent failure. Source-of-truth for the pin URL is the tooltip
expression already in the file (`linkedTab?.url || pin.url`, ~line 950) — copy the
same thing so the menu and the hover agree. Confirm `Copy01Icon` (or the closest
HugeIcons copy glyph) is exported by `@hugeicons/react` before importing; the file
already imports `HugeiconsIcon` and several glyphs.

---

_When task status flips to `done`, move this file to `done/`._
