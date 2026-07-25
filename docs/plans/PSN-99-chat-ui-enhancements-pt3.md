# PSN-99 — [chat] UI enhancements pt3 (plan)

Status: grilled — decisions resolved · plan-only · 2026-07-25
Issue: https://linear.app/withdustin/issue/PSN-99

FE-only polish pass over the `/chat` Teams app across five areas: Settings, Message
bubbles, Chat list, Profile modal, Lightbox. Two items touch the backend and are
resolved below (one allowed as a scoped tweak, one deferred). Probe host
`100.85.206.8:9222`, verify live with `/cdp`.

## Baseline (probed 2026-07-25, code)

- **Settings sheet** (`chat/src/components/settings-sheet.tsx`): shadcn `Sheet` with no
  `side` prop → defaults to **right** (`src/components/ui/sheet.tsx:45`), `w-80`,
  `modal={false}`, no overlay, `showCloseButton={false}` with a custom X in
  `SheetHeader` (`settings-sheet.tsx:244`). Settings: theme, density, names, font,
  mono font, notify sound, notifications toggle, Electron server URL. Persisted per
  device in server ui-state via `chat-settings.ts` + `use-chat-settings.ts`
  (`data-density`/`data-font`/`data-mono` on `<html>`; `.dark` class).
- **Font sizing**: no `font-size` on `html`/`:root` in `src/index.css` or
  `chat/src/index.css`; browser default 16px. **No base-font-size control**. Text
  sizes are hardcoded `rem`/`em` literals. Density (`data-density="compact"`) changes
  **padding + line-height + `.teams-message-body` font-size (0.8125rem) + bubble
  radius** (`chat/src/index.css:339–359`) — not just padding.
- **Electron titlebar** (`chat-main.js:67`): `titleBarStyle:"hiddenInset"`,
  `trafficLightPosition {x:19,y:17}`. Drag/no-drag CSS (`src/index.css:615–620`) only
  covers `.titlebar` children. The settings Sheet renders in a Radix **portal outside
  `.titlebar`**, so its top overlaps the ~28px macOS OS drag band with **no
  `-webkit-app-region:no-drag`** — the X button (near the top) is swallowed by the OS
  drag region. Root cause confirmed.
- **Message action bar** (`message-row.tsx:388–493`): hover cluster sits **beside** the
  bubble (`flex-row-reverse` for self). Order: Reply → QuickReact (a pill with **6
  `size-7` emoji + a "+"** ≈ 210px wide) → "…" menu. This wide quick-react pill is why
  the row exceeds the viewport. Timestamp is **tooltip only** (`title=` on the bubble,
  `message-row.tsx:439`) — no visible time.
- **Bubble width** (`message-row.tsx:392`): outer `max-w-[85%] md:max-w-[65ch]`, bubble
  `w-full` inside, `[overflow-wrap:anywhere]`. `pre` blocks `overflow-x:auto`
  (`chat/src/index.css:467`). Horizontal scroll comes from wide inline content / server
  markup, not a hard cap failure.
- **Reaction chips** (`message-row.tsx:531–558`): below bubble, `rounded-full border
  px-2 py-0.5 text-xs`, emoji + mono count; mine `border-primary bg-primary/15`.
- **Sticky date separator** (`thread-view.tsx`): thread is `flex-col-reverse`, which
  **breaks CSS `position:sticky`**, so a **scroll-driven floating overlay pill**
  (`thread-view.tsx:1134–1144`) mimics it — set on scroll, cleared by a 1200ms timeout,
  `transition-opacity duration-300`. The "border lingers after text" artefact is the
  opacity fade leaving the pill box briefly visible.
- **Self bubble** (`message-row.tsx:401`): `bg-primary text-primary-foreground` (solid
  coral) in **both** themes — the "white in dark" complaint is the bright coral.
- **FABs** (`thread-view.tsx:1146–1177`): scroll-to-bottom + jump-to-unread, slide-in
  via opacity/translate; **no hover opacity swap**.
- **Avatars** (`user-avatar.tsx`): single first-letter, fixed `bg-primary/10 text-primary`
  (all same color). Groups → `FacepileAvatar` (two overlapping circles). No hash color.
  No `[TG]` bracket exists in code (issue text was from an older build).
- **Filters + folders** (`conversation-list.tsx:428–447`, `546–633`): filter pills
  (all/unread/mentions) and folder headers render **inside** the scroll container →
  **not sticky**.
- **Connection status** (`chat-app.tsx:1005–1011`): a `fixed top-0` centered
  "Reconnecting…" pill overlay, not a sidebar element.
- **Context menu** (`conversation-row-menu.tsx`): Move to folder, Labels, Rename, Mute,
  Notify-on-mention. **No mark-as-read** (only the `u` key + ⌘K expose it).
- **Profile avatar** (`profile-dialog.tsx:63`, `user-avatar.tsx:63`): `UserAvatar` hits
  `/api/teams/avatar?userId=<oid>`; server (`server.mjs:1721`) calls Graph
  `photos/48x48/$value` — **hardcoded 48px**, no size param. Avatar **not clickable**.
- **DM button** (`chat-app.tsx:948–964`): "Message" only appears when an existing 1:1 is
  found by scanning `conversations`; there is **no** `createConversation`/`startDm` in
  `teams-client.ts` or `server.mjs` — a DM with a not-in-history user is impossible
  without a new BE route.
- **Lightbox** (`image-lightbox.tsx`): a single click **anywhere (incl. the image)**
  closes when not zoomed (`onStageClick`, `136–139`); cursor shows `zoom-in` but click
  closes (mismatch). Gestures: wheel = zoom-around-cursor, double-click = toggle
  2.5×/fit, drag = pan (only when zoomed), 2-finger = pinch. **No single-click zoom.**

## Decisions (grilled 2026-07-25)

1. **4.2 DM-for-everyone → DEFERRED.** Needs a new `POST /api/teams/create-dm` BE route
   (resolve/create a 1:1 thread id from an oid). Out of scope for this FE PR; file a
   follow-up BE task. Profile "Message" stays history-only for now.
2. **4.1 full-res avatar → ALLOWED (scoped BE tweak).** Add a `size` param to the
   existing `/api/teams/avatar` route, threaded into the Graph URL (e.g. `240x240` /
   `648x648`). The one sanctioned BE change in this PR.
3. **1.2 font-size → SLIDER, message + list text.** A continuous slider (≈12–20px)
   driving a new `--chat-font-scale` var that multiplies **message body + conversation
   row + composer** text only. Icons, padding, timestamps, and layout stay fixed (not a
   whole-UI zoom). Persist per device in server ui-state like other chat settings.
4. **2.6 self bubble → OUTLINE in dark.** Dark-mode self bubble = base/near-transparent
   fill with the **current coral (`--primary`) as the border**, foreground text. Light
   mode keeps the solid coral fill. Still clearly "yours", no glare.
5. **3.1 avatars → 2-letter initials on a hashed gradient.** Up to 2 initials
   (first+last). Default (photo-less) avatars get a subtle gradient of two hues picked
   from a fixed ~10-hue palette, hashed by oid/convId — consistent everywhere (list,
   message rows, profile). Groups keep the facepile, each member hashed.
6. **5.1/5.2 lightbox** (from the issue spec, coherent): single click **zooms at the
   pointer** (no longer closes); double-click **resets** to fit; **plain scroll/drag =
   pan**, **pinch (trackpad ctrl+wheel) = zoom**; close **only** via the X button or a
   click on the backdrop **outside the image**. Cursor matches action (zoom-in when
   fit, grab/grabbing when panning).
7. Reaction-badge redesign (2.3) and message-action split (2.1) are design proposals
   below; may build a `/prototype` first in the build phase if multiple looks are worth
   comparing.

## Approach

- Keep everything FE except decision 2's single `size` param on `/api/teams/avatar`.
- Introduce **two new per-device settings** — `fontScale` (slider) — via the existing
  `chat-settings.ts` + `use-chat-settings.ts` pattern (a `--chat-font-scale` CSS var on
  `<html>`, consumed by `.teams-message-body`, `.conv-row` text, composer).
- Density (2.4) is reworked to change **padding only**; message text size + paragraph
  spacing become identical across comfort/compact (font-size now owned by the slider).
- All new pure logic (avatar hash→gradient+initials, lightbox gesture mapping) lands in
  `chat/src/lib/*` with Vitest tests (TDD for pure fns), per repo convention.

## Workstreams (each ≈ one session)

### A — Settings (area 1)
- A1 `1.1` Move settings sheet to the **left** (`side="left"` on the chat `Sheet`; check
  the mouse-leave auto-close geometry still arms correctly for a left sheet).
- A2 `1.2` Font-size **slider** → `--chat-font-scale` var; new `fontScale` setting in
  `chat-settings.ts`/`use-chat-settings.ts`; apply to message + list + composer text.
- A3 `1.3` Electron X-button fix: add `-webkit-app-region:no-drag` to the sheet
  content/header (portal is outside `.titlebar`), and/or pad the header below the ~28px
  OS drag band. Verify clickable in the Electron shell.

### B — Message bubbles (area 2)
- B1 `2.1` Split the action bar: **side** keeps timestamp `HH:mm:ss` (new visible text,
  replacing the `title` tooltip) + reply + "…" (self only). **Move the quick-react
  emoji bar to the top edge of the bubble** (compact popover on hover), shrinking the
  side cluster so the row no longer exceeds the viewport.
- B2 `2.2` Audit + fix bubble horizontal overflow (long tokens/URLs, `pre`/`code`, wide
  media) so the thread never scrolls sideways; tighten `max-w`/`min-w-0`/`overflow-wrap`.
- B3 `2.3` Redesign the sent reaction badges (better chip visual; propose 1–2 looks,
  optional `/prototype`).
- B4 `2.4` Density = **padding only**; equalize bubble text font-size + paragraph
  spacing across comfort/compact.
- B5 `2.5` Polish the sticky date-separator disappear (fix the "border lingers after
  text" fade — fade the whole pill as one unit / remove the empty box artefact).
- B6 `2.6` Self bubble **outline** treatment in dark (transparent fill + coral border).
- B7 `2.7` FAB hover swap: default translucent (opacity), **solid on hover**.

### C — Chat list (area 3)
- C1 `3.1` Hashed **2-letter + gradient** default avatars (new pure
  `chat/src/lib/avatar-style.ts` + tests); apply in list, message rows, profile.
- C2 `3.2` Make filter pills + folder-name headers **sticky** on scroll (sticky
  sub-headers within the scroll container).
- C3 `3.3` Move connection status to a **sidebar-bottom status bar** (absolute,
  conditional), reserving the strip for future statuses (e.g. PSN-93 backfill).
- C4 `3.4` Add **Mark as read / unread** to the conversation-row context menu (reuse the
  existing `toggle-read` action).

### D — Profile modal (area 4)
- D1 `4.1` Add `size` param to `/api/teams/avatar` (BE), request a larger photo in the
  modal, make the avatar **clickable → lightbox** (reuse `image-lightbox.tsx`).
- D2 `4.2` **DEFERRED** — file a BE follow-up for DM-for-everyone.

### E — Lightbox (area 5)
- E1 `5.1` Close only on **X** or **backdrop-outside-image** click (stop close-on-image).
- E2 `5.2` Gesture rework (mac-first): single click = zoom at pointer, double-click =
  reset, plain scroll/drag = pan, pinch = zoom; matching cursors. Pure gesture-mapping
  in `chat/src/lib/lightbox-zoom.ts` (extend) + tests.

### F — Bug sweep (last)
- Cross-check all five areas at both themes + comfort/compact + Electron & web PWA;
  fix regressions; run full gate (vitest, typecheck, biome `check:changed`) + live
  `/cdp` verification against the probe host.

## Dependency / parallelism

| WS | Depends on | Parallel with | Notes |
|----|------------|---------------|-------|
| A  | —          | B, C, E       | Settings-local |
| B  | A2 (font var) for B4 | C, E | B4 waits on the font-scale var; B1–B3,B5–B7 independent |
| C  | —          | A, B, E       | C1 pure lib first |
| D  | E (reuses lightbox) + BE size param | — | Do after E |
| E  | —          | A, B, C       | Self-contained |
| F  | all        | —             | Last |

Suggested order: A ∥ C ∥ E → B → D → F.

## Acceptance criteria

- [ ] 1.1 Settings sheet opens on the left; auto-close/keyboard behavior intact.
- [ ] 1.2 Font-size slider scales message + list + composer **text only** (no icon/layout
      zoom); persists per device; survives reload.
- [ ] 1.3 Settings X button is clickable in the Electron shell.
- [ ] 2.1 Side action bar = timestamp `HH:mm:ss` + reply + "…"(self); quick-react moved to
      bubble top; row never exceeds the viewport width.
- [ ] 2.2 No horizontal scroll on any message (long URLs, code blocks, media).
- [ ] 2.3 Reaction badges visibly improved (before/after screenshots).
- [ ] 2.4 Message text size + paragraph spacing identical across comfort/compact; only
      padding differs.
- [ ] 2.5 Date separator fades cleanly — no lingering empty bordered box.
- [ ] 2.6 Dark-mode self bubble is transparent-fill + coral border, low glare.
- [ ] 2.7 FABs are translucent by default, solid on hover.
- [ ] 3.1 Default avatars show 2-letter initials on a per-id hashed gradient everywhere.
- [ ] 3.2 Filters + folder names stay sticky while the list scrolls.
- [ ] 3.3 Connection status lives in a sidebar-bottom status strip, shown conditionally.
- [ ] 3.4 Context menu has Mark as read / unread.
- [ ] 4.1 Profile avatar is crisp (higher-res) and opens in a lightbox on click.
- [ ] 5.1 Lightbox closes only on X or backdrop-outside-image.
- [ ] 5.2 Single-click zoom-at-point, double-click reset, scroll/drag pan, pinch zoom,
      matching cursors.
- [ ] Gate green: vitest, typecheck, biome `check:changed`; live `/cdp` verified light +
      dark; both Electron and web PWA sane.

## Risks

- **R1 Font-scale blast radius** — a global var could leak into unintended text. Scope
  the var to explicit selectors; test both densities and the Electron shell.
- **R2 flex-col-reverse + sticky (3.2)** — the thread reverse layout already breaks
  `position:sticky`; the list is *not* reversed so plain sticky should work, but verify
  no reverse container wraps the filters/folders.
- **R3 Lightbox gesture conflict (5.2)** — remapping wheel from zoom→pan changes muscle
  memory; ensure pinch (ctrl+wheel) still zooms and drag-vs-click discrimination holds.
- **R4 Avatar hash contrast** — gradients must keep initials legible in light + dark;
  clamp lightness / test WCAG-ish contrast.
- **R5 Electron no-drag fix regressions** — over-applying `no-drag` could break window
  dragging; scope it to the sheet only.

## Out of scope

- **4.2 DM-for-everyone** (deferred BE task: `POST /api/teams/create-dm`).
- Any BE change beyond the `/api/teams/avatar` `size` param.
- Rich-HTML/adaptive-card render, virtualization, and other non-listed chat work.
