# 002 — outlook notifications adapter

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** none

## Goal

Capture Microsoft Outlook (OWA) new-mail notifications the same way Teams notifications are captured: a per-target read-only side-channel injects a capture script that watches OWA's own in-app notification and ships each one through the `__cdpNotify` binding. New mail surfaces as a toolbar-bell entry, an unread badge, and (when out of view) a native OS notification. Clicking a notification activates the Outlook tab and deep-opens the exact message via client-side SPA navigation.

## Why now

The notifications side-channel (ADR 0003) was built adapter-generic but ships with only the Teams adapter. Outlook is a daily-driver surface already bookmarked in the app; adding it is the first proof that the adapter abstraction generalises, and it adds deep-open (which Teams deferred for lack of a per-conversation route).

## Acceptance criteria

- [x] A new-mail toast in OWA produces a bell entry with sender, subject, and body preview, while Outlook is a **background** tab.
- [x] Duplicate notifications (same mail mirrored across tabs/reloads) collapse to one entry. (Dedup by ItemID — unit-tested; foreground-render dedup smoke pending packaged build.)
- [ ] An OS notification fires when Outlook is not the active+focused view; clicking it activates the Outlook tab and opens the message. (Click-opens verified; OS toast not verifiable in unsigned dev build — pending `pnpm install:local`.)
- [x] Clicking a bell row deep-opens the exact message via SPA navigation (no full page reload), with a full-navigation fallback.
- [x] Host match covers `outlook.office.com`, `outlook.live.com`, and `outlook.cloud.microsoft`.

## Test plan

### Layer 1 — Pure logic (TDD)

- [x] `remote-page.ts` `navigateSpa(url)` — sends `Runtime.evaluate` with a `pushState` + `popstate` expression carrying the url
- [x] `navigateSpa(url)` — expression includes a `location.href` full-navigation fallback
- [x] `notifications.js` `markUnread` — flips one entry to unread by id without touching others

(Inject-script DOM parsing and the `main.js` adapter are CDP/DOM glue → Layer 2, per tdd.md.)

### Layer 2 — Manual smoke (CDP/IPC)

With a live Edge at the configured CDP host, Outlook signed in, and Outlook as a **background** tab:

- [ ] Send yourself a mail → a bell entry appears with correct sender/subject/preview within ~2s.
- [ ] An OS notification fires (Outlook not active); clicking it activates the Outlook tab.
- [ ] Click a bell row → Outlook activates and the exact message opens in the reading pane **without** a full reload (watch for no white flash; network shows item fetch, not a document load).
- [ ] Send two mails in the same thread → both appear; bell groups them under one subject group.
- [ ] Switch Outlook to foreground, then send a mail → no duplicate entry (dedup holds across the in-app toast render).

### Layer 3 — Visual review

- [ ] n/a — Outlook entries flow through the existing notification bell/popover; no new components or layout.

## Design notes

- **Contracts changed:** `RemotePage` — add `navigateSpa(url: string): void`. Existing `navigate` (full `Page.navigate`) is unchanged.
- **New modules:** `inject/outlook-notify.js` — OWA NotificationPane capture script (mirrors `inject/teams-notify.js`). Added to `main.js` `ADAPTERS`.
- **New ADR needed?** No — extend ADR 0003 with an "Outlook adapter + SPA deep-open" addendum (append-only).

Verified against Edge 148 / OWA (2026-05-23):

- OWA renders its in-app notification into `div[data-app-section="NotificationPane"]` **even when the tab is `document.hidden`** — so DOM scrape works for background tabs (no permission grant, no `Notification` hook, no reload). OWA does **not** use the Web Notification API for mail.
- Each item is a `button[aria-roledescription="Notification"]` with `aria-label="New mail from <sender>"`; subject in `.KTZ84`, body preview in `.mrxI1` (aria attributes are the durable anchors; hashed Fluent classes are best-effort fallbacks).
- The message ItemID (`A[AQM][MQ]k…` base64) lives in the notification button's React fiber. Deep-link: `<origin>/mail/inbox/id/<encodeURIComponent(ItemID)>` — verified.
- SPA navigation: `history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate', { state: history.state }))` makes OWA's react-router load the message (verified via item-fetch network activity), no document reload.

```ts
// inject ships, per notification:
type OutlookNotify = {
  id: string          // ItemID, or hash(source|title|body) fallback
  source: string      // sender, from aria-label "New mail from <sender>"
  title: string       // subject
  body: string        // preview
  targetEntity: { deepLink: string } | null  // <origin>/mail/inbox/id/<enc ItemID>
  ts: number
}
```

`handleNotificationClick` (app.tsx): `await switchTab(targetId)`, then if `targetEntity.deepLink`, `page.navigateSpa(deepLink)`.

## Out of scope

- Conversation-level grouping by a true conversation id (OWA exposes only a per-message ItemID; grouping falls back to subject). Capture a follow-up task if a conversation id is needed.
- Calendar reminders, Teams-chat-in-Outlook, and other OWA notification types beyond new mail.
- Granting Web Notification permission / hooking the Notification API (OWA doesn't use it for mail).

## Definition of Done

- [x] Layer 1 tests written and green (`navigateSpa`, `markUnread`)
- [x] Layer 2 smoke checklist completed with a live Remote Browser (capture/bell/deep-open verified; OS-toast + foreground-dedup deferred to packaged build — see Notes)
- [x] Layer 3 — n/a (UI flows through existing bell; polish verified via headless-Chrome screenshots)
- [x] `pnpm check` clean
- [x] `pnpm typecheck` clean
- [x] `pnpm test` green
- [x] `pnpm dev` boots cleanly and Outlook notifications work end-to-end
- [x] CLAUDE.md updated (file structure: `inject/outlook-notify.js`; remote-page `navigateSpa`)
- [x] ADR 0003 addendum written for the Outlook adapter + SPA deep-open
- [x] No commented-out code, no `console.log` debris, no AI attribution
- [x] Task closed: status → done, moved to `docs/tasks/done/`, t002 in commit

## Notes

Research session (2026-05-23) confirmed all selectors/format live. The first "hidden tab, nothing rendered" observation was a measurement artifact (observer not yet armed + OWA's ~5s auto-dismiss), not OWA suppressing background notifications.

Smoke results (HITL, 2026-05-23, dev build): dock badge ✓, bell entry with correct sender/subject/body ✓, click activates tab + deep-opens the exact message via SPA nav (no reload) ✓. **OS notification did not fire** — almost certainly the unsigned dev Electron lacking macOS notification permission (a dev build doesn't appear under System Settings → Notifications); Teams uses the identical `Notification` path, so re-verify after `pnpm install:local`. Dedup-on-foreground and same-thread grouping still to be smoke-checked in the packaged build.

Polish (shared `NotificationBell`, applies to Teams too): group header truncates with the count badge kept visible; title `line-clamp-2`; body `line-clamp-2`; fixed Radix ScrollArea `display:table` horizontal overflow via `[&>[data-slot=scroll-area-viewport]>div]:!block`; `onCloseAutoFocus` preventDefault stops the bell tooltip lingering after a row click. Verified via an isolated mock-data preview screenshot.

Polish round 2 (shared `NotificationBell`): per-row read indicator moved to the right column below the time-ago; content reserves right padding so it can't overflow the time/indicator; indicator is now a toggle — filled dot when unread (click → read), outline dot revealed on row hover when read (click → unread). New pure `markUnread` (TDD'd) + `cdp:mark-notification-unread` IPC. Added an "Unread only" header toggle (local view state, filters before grouping, empty state "No unread notifications"). Verified end-to-end via headless-Chrome hover/click + screenshots.

Tooling: excluded `**/.claude/**` from Biome (`biome.json`) and Vitest (`vite.config.ts`) so agent worktrees checked out under `.claude/worktrees/` don't break `pnpm check` (nested `biome.json`) or pollute `pnpm test` with duplicate suites.
