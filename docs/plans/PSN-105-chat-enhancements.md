# PSN-105 — [chat] Enhancements

**Issue:** https://linear.app/withdustin/issue/PSN-105/chat-enhancements
**Absorbs:** [PSN-106](https://linear.app/withdustin/issue/PSN-106/chat-new-messages-not-delivered) — new messages not delivered
**Branch:** `chat-enhancements` · one branch, one PR
**Surface:** `/chat` (chat renderer + `apps/chat-server` BFF + the `/internal/teams/*` seam in `web/server.mjs`)

## Goal

Close the gap between "a working Teams client" and "a client I'd pick over native Teams". Three classes of work:

1. **Delivery correctness** — messages must arrive without the window being focused, and without a refresh (PSN-106).
2. **A genuinely new capability** — local edit/delete history, because Teams itself throws the previous version away.
3. **Polish** — the accumulated small wrongs that make the app feel unfinished: stale overlays, missing tooltips, unstyled links, a lightbox that reopens itself.

## Baseline (probed 2026-07-27, not assumed)

Facts established before planning. Every claim has a `file:line` in the probe notes.

### Delivery (PSN-106)

- `chat/src/lib/chat-ws.ts:133` — the only things that set the status to `reconnecting` are `onclose` / `onerror`. There is **no liveness timer**. A browser `WebSocket` cannot send pings and does not surface the server's, so a half-open socket (sleep/wake, wifi change, tailnet re-route, LB dropping state) leaves the client reporting `online` with a socket that will never deliver another frame.
- The server does ping — `apps/chat-server/src/ws-hub.ts:176` pings every 20s and `terminate()`s at 60s — but a terminate on a dead path never reaches the client. The client keeps the zombie.
- `chat/src/components/conversation-list.tsx:319` — the sidebar's fallback poll **and** its `window.addEventListener("focus", refresh)` both sit behind `if (status === "online") return`. With a lying status the sidebar has no recovery path at all, on any event, until a full reload.
- `chat/src/components/thread-view.tsx:650` — the thread's poll is gated the same way, but its focus handler is outside the gate, so the *visible* thread self-heals on focus. A non-visible pane does not.
- `apps/chat-server/src/sweep.ts:154` — `messages-upsert` is broadcast **only for the one focused conversation**. Every other conversation's new message reaches the sidebar solely as a `lastMessageVersion` bump on the conv row (`sweep-plan.ts:75`, `store.ts:178`, `core/teams-store.js:204` — three separate version gates).
- `chat-main.js:71` — the Electron window does not set `backgroundThrottling: false`, so a minimised renderer's timers stretch.

Matches all three reported symptoms exactly: must-refresh, sidebar-and-thread both missing, and worst when unfocused (the one `focus` handler that papers over the thread half never fires).

### Edit / delete

- Teams exposes **no** previous version. `core/teams-render.js:599` reads `properties.edittime` for truthiness only; the value is discarded. A deleted message arrives as a tombstone with `deletetime` set and the content blanked (`teams-render.js:555`).
- `apps/chat-server/src/store.ts:39` — `messages` has `body`, `raw`, `edited`, `deleted`. `upsertMessages` (`store.ts:320`) is a plain `ON CONFLICT DO UPDATE` that **overwrites `body` in place**. The prior text is destroyed at that one line — which is also the one place we can intercept it.
- `apps/chat-server/src/routes.ts:135` / `:142` — edit and delete are pass-through to the provider with no store write; the change lands on the next sweep.
- The sweep already detects an edit (`sweep-plan.ts:60` compares bodies) and a delete flip (`:62`).

**Ceiling, stated plainly:** we can only record changes our BFF observes after this ships. Edits made before the feature exists, or while the server is down, are unrecoverable. This is a property of the Teams API, not of our implementation.

### Local state persistence

Contrary to the issue's framing, nearly everything **already persists** server-side: folder collapse (`chatFolders_<deviceId>`), panel widths, theme, density, fonts, sounds, AI panel state — all in server ui-state on the `/data` volume; labels, folders, mute, custom titles in `chat.db`. The single fragile link is `localStorage["cdp_device_id"]`. Lose it and every `<key>_<deviceId>` slot is orphaned — the values survive on the server but nothing points at them, so everything reads as default. `chat:reload` (`chat-main.js:126`) does not touch localStorage, and the SW cache name is a hardcoded literal, so neither is an obvious culprit. **Cause not yet proven → diagnostics before a fix** (grilled decision).

### Build / version info

- `vite.config.chat.ts:31` — `__GIT_SHA__` is the hardcoded literal string `"chat"`. The chat build bakes no real SHA. (The main `/` build does, `vite.config.ts:9`.)
- `chat-main.js` never calls `app.getVersion()`; the preload bridge (7 methods) exposes no version.
- `web/server.mjs:2566` — `GET /api/version` returns `{version, sha, persistent}` for the web server. `apps/chat-server/src/index.ts:84` has `GET /health` → `{ok:true}`.
- The BFF tracks `lastHealthOk` (`sweep.ts:63`) but **no sweep timestamp and no error log**.

### UI polish items

| Item | Baseline |
|---|---|
| URL tooltip | Present but conditional — `link-label.ts:63` sets `title` only on links it elides, and only if no `title` exists. A non-elided link has no tooltip. |
| Reaction bar / link-copy stale | Both are timer-only hide (`message-row.tsx:207` 140ms, `link-hover-copy.tsx:44` 180ms). No `blur` / `visibilitychange` / route-change reset. |
| Copy message URL | Does not exist. No Teams deep-link format anywhere in the repo. |
| Missing tooltips | `ReplyButton`, `MessageActions` ⋯ trigger, `QuickReact` ×7, `CoarseReactSheet`, `ChipCopyButton`, `link-copy-btn`, `NotifyToggle`. Composer and header are already clean. |
| "Sending…" | `message-row.tsx:603`. |
| Unread preview line | `conversation-row.tsx:155` — title is `font-semibold` when unread, but the preview line is distinguished by **colour only**, never weight. |
| Profile ↔ lightbox | `profile-dialog.tsx:44` — `lightboxOpen` is never reset when `target` changes or the dialog closes. Close the profile while the lightbox is open and it re-opens on the next profile you view. |
| Link styling | `index.css:517` — underline only, colour inherited from the bubble, no weight. No Jira pattern in `link-label.ts` (Azure DevOps PR is handled). |
| Composer toolbar | `composer.tsx:77` `FORMAT_INLINE_MIN_WIDTH = 480`, measured by `ResizeObserver` on the composer **card** — correctly container-relative, so it already reacts to the AI panel opening. Only the *format* cluster collapses; attach/emoji/GIF/sticker never do. |

## Decisions (grilled 2026-07-27)

1. **Edit history — full local version log.** New `message_edits` table; snapshot the old body + timestamp on every observed body change and on the flip to deleted. Ceiling accepted: only changes observed after ship.
2. **Edit-history UI — popover with a version stack.** `(edited)` becomes a subtle button opening a shadcn Popover, versions newest→oldest with relative timestamps, current version marked. Deleted messages get a `deleted · view original` tombstone using the same popover. No inline expansion (would shift the `flex-col-reverse` thread), no diff view (extra dep, sanitized-HTML hazard).
3. **PSN-106 — rework delivery to push message deltas beyond the focused conversation**, *plus* the liveness watchdog and the ungated focus refresh. The watchdog is not optional: without it a zombie socket kills the new deltas exactly as it kills today's.
4. **Delta fetch scope — conversations that changed this tick.** The 12s list sweep already names the rows whose `lastMessageVersion` bumped; fetch history for those only (usually 0–2) and broadcast `messages-upsert` per conversation. The focused conversation keeps its faster 4s lane. Rejected: rotating over the top 20 (20 in-page CDP fetches per cycle through one keeper tab) and a periodic full reconcile.
5. **Copy message URL — both.** `Copy link` (our own `{server}/chat/c/{convId}?msg={msgId}`, reusing `jump-mode.ts`) and `Copy Teams link` (native). The Teams format is undocumented → must be proven live against the probe host before it ships; if it can't be proven, the native item is dropped and only the app link ships.
6. **Settings — About card + Sync card.** About: app version, real git SHA, built-at, server version/SHA, reachability. Sync: last successful sweep (live relative), last error + code, and the last ~20 sync events from a new BFF endpoint.
7. **Local-state resets — diagnose before fixing.** The probe shows the state is already durable; the reported reset has no proven cause. Surface the live `deviceId` and the server's known device slots in the About card, then decide. No speculative rework of the identity model this pass.
8. **Order — bug first.** Delivery, then the visibility/stale bugs, then edit history, then Settings, then the polish batch, then the composer, then a bug sweep.

## Workstreams

Each is one session. `→` = depends on.

### A — Delivery rework (PSN-106) `[bug]`

The whole reason the app feels unreliable. Do it first.

- `chat-ws.ts`: stamp `lastFrameAt` on every `onmessage`; a 45s watchdog (server pings at 20s) force-closes a silent socket so the existing backoff reconnects.
- `conversation-list.tsx:319`: move the `focus` listener out of the `status === "online"` early return.
- `sweep.ts`: after the list lane computes `changedConversations`, fetch history for each changed conversation and broadcast `messages-upsert` per conversation — not just for the focused one.
- `chat-main.js`: `backgroundThrottling: false` on the chat window.
- Consider (cheap, same file): drop the `if (s.status !== "ready") return s` guards that discard the connect-time snapshot in `conversation-list.tsx:292` and `thread-view.tsx:608` when a reconnect lands mid-refetch.

**Evidence:** two clients side by side, second window minimised; send from Teams; the minimised window's sidebar and thread both update with no focus and no reload. Plus a forced half-open socket (kill the server socket without a close frame) recovering inside 45s.

### B — Visibility + stale-overlay bugs `[bug]`

- Reaction quick-react bar and the link-hover-copy button: reset on `blur`, on `visibilitychange`, and on conversation change. One shared hook rather than two copies of the logic.
- `profile-dialog.tsx`: reset `lightboxOpen` when `target` changes and when the dialog closes.
- URL tooltip: restore a full-URL tooltip on **every** link, not only elided ones (`link-label.ts:63`).

**Evidence:** screenshots of the three repros before/after — hover a reaction bar then ⌘-Tab away; open avatar → close profile → reopen profile; hover a short link.

### C — Edit / delete history `→ A`

- `core/teams-render.js:599`: emit the `edittime` **value**, not just its truthiness.
- `contract.ts` + `teams-provider.ts` + `upsert-map.ts`: carry `editTs` through.
- `store.ts`: new `message_edits` table `(service, conv_id, msg_id, body, edit_ts, captured_at)`; in `upsertMessages`, read the existing row first and snapshot the old body when the incoming body differs or the message flips to deleted. `ADDED_COLUMNS` migration for `messages.edit_ts`.
- New `GET /api/chat/message-history` route.
- `message-row.tsx`: `(edited)` → popover trigger; deleted tombstone → `view original`.

**Evidence:** edit a message twice from native Teams, then read all three versions back in the popover. Delete a message and recover its text. Unit tests on the snapshot reducer.

### D — Settings: About + Sync `→ A`

- `vite.config.chat.ts:31`: bake the real SHA + a build timestamp (mirror `vite.config.ts:9`).
- `chat-main.js` + `chat-preload.js` + `chat-shell.ts`: new bridge method returning app version, Electron build hash and built-at.
- BFF: track last sweep ok/at/error and a ring buffer of the last 20 sync events; expose over a new route + reuse the existing `health` WS frame.
- `settings-sheet.tsx`: About card (app + server version/SHA/built-at, reachability, and the live `deviceId` per decision 7) and Sync card (last sync, last error, event log).

**Evidence:** screenshots light + dark; kill the BFF and confirm the reachability state goes red and the sync card shows the error.

### E — Polish batch `→ B`

- Tooltips on the eight enumerated icon buttons (shadcn `Tooltip`, replacing native `title` where present).
- Remove the "Sending…" text; the existing opacity carries it.
- Bold the preview line in the sidebar when unread (weight, keeping the existing colour treatment).
- Links in messages: bold + accent colour. Self-bubble sits on `--primary`, so the accent must be chosen per bubble side or contrast breaks — verify both visually.
- `link-label.ts`: Jira pattern → `GU-1933`, `CUBEFIB-8106` from `*.atlassian.net/browse/{KEY}`.
- Copy message URL: app link always; Teams link only if the format is proven live.

**Evidence:** one screenshot sheet, light + dark, before/after.

### F — Composer overflow `→ E`

Extend the existing container-width `ResizeObserver` so the non-format actions (attach, emoji, GIF, sticker) collapse into a ⋯ dropdown below a second breakpoint, keeping send and the format toggle always visible. Verify with the AI panel open at the narrowest useful width.

### G — Bug sweep

Re-walk every item, re-run the gates, catch regressions from A–F.

### Dependency / parallelism

| WS | Depends on | Can run parallel with | Model |
|---|---|---|---|
| A | — | B | Opus (distributed delivery reasoning) |
| B | — | A | Sonnet |
| C | A | D | Opus (schema + migration) |
| D | A | C | Sonnet |
| E | B | F (after E lands) | Sonnet |
| F | E | — | Sonnet |
| G | A–F | — | Opus |

## Acceptance criteria

- [ ] A new Teams message appears in the sidebar **and** the open thread within ~15s with the window minimised and never focused, on Electron prod. No reload.
- [ ] A half-open socket is detected within 45s and reconnects on its own; the "Reconnecting…" banner tells the truth.
- [ ] A new message in a **non-focused** conversation updates that row and, when opened, the thread already has it.
- [ ] Editing a message twice from native Teams shows all three versions in the popover with timestamps.
- [ ] Deleting a message from native Teams leaves a tombstone that can reveal the original text.
- [ ] The reaction bar and link-copy button are gone after ⌘-Tab away and after a conversation switch.
- [ ] Opening an avatar, closing the profile, and reopening any profile does **not** show the lightbox.
- [ ] Every link in a message shows its full URL on hover.
- [ ] Settings shows app version + real SHA + built-at, server version + reachability, last sync time, and a sync event log.
- [ ] Every icon-only button in the chat renderer has a shadcn Tooltip.
- [ ] "Sending…" is gone; the unread preview line is bold; message links are bold + accent; a Jira URL renders as its ticket key.
- [ ] The composer's actions collapse into a ⋯ menu at narrow width with the AI panel open, send always reachable.
- [ ] `pnpm test`, `pnpm test:e2e`, `pnpm typecheck`, `pnpm check:changed` all green.
- [ ] Every UI-touching change has a light + dark screenshot from a real build.

## Risks

- **R1 — Teams deep-link format is undocumented.** Mitigation: prove it live against the probe host early in E; if unprovable, ship the app link alone (decision 5 already allows this).
- **R2 — Fetching history for every changed conversation adds load to the single keeper tab.** All Teams traffic funnels through one in-page CDP channel shared with mark-read, the 12s list fetch and the 4s history fetch. Mitigation: only changed rows (decision 4), and watch for sweep stalls in G. Related: PSN-102 made `teamsMarkRead` two sequential `Runtime.evaluate` round-trips on that same channel, fired on every conversation open — worth a separate ticket if A surfaces contention.
- **R3 — Edit-history storage grows unbounded.** A chatty edited thread accumulates rows forever. Mitigation: cap versions per message (keep the newest N) and state the cap in the popover.
- **R4 — The version gate can still silently drop a conversation** if Teams reports a new message without bumping `lastUpdatedMessageVersion` (three gates, `sweep-plan.ts:75` / `store.ts:178` / `core/teams-store.js:204`). Not fixed by this plan and not the PSN-106 cause (a reload wouldn't fix it, and reloading does fix the reported bug). Mitigation: log when a row arrives with a non-rising version but a different `lastMessageId`, so we learn whether it happens at all.
- **R5 — Accent-coloured links on the self bubble** may fail contrast against `--primary`. Mitigation: per-side treatment, verified visually in both themes.
- **R6 — The local-state reset has no proven cause.** Deliberately deferred to diagnostics (decision 7); if the About card shows a churning `deviceId`, the Electron-owned-id fix follows in a later pass.

## Out of scope

- Rich adaptive-card rendering (`properties.cards`).
- Inline AMS playback of call recordings — chips link out to SharePoint, unchanged.
- Trouter / real-time push from Teams. Delivery stays poll-based per ADR-0019.
- Arbitrary file attachments (non-image upload).
- Any change to the `/` browser PWA. This is `/chat` only.
- Reworking the per-device prefs model (decision 7 defers it).
- Fixing R4's version-gate hole — logging only this pass.
