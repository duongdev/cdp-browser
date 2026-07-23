# PSN-95 — Chat UI enhancements part 2 (plan)

Status: draft — open questions pending grill · plan-only · 2026-07-23
Issue: https://linear.app/withdustin/issue/PSN-95

Part 2 of the `/chat` polish epic (part 1 = PSN-90, t149–t157). Scope: lightbox
v2, richer media handling, a user profile dialog, smarter mutes, conversation-row
upgrades (avatar-anchored unread, custom titles, mention counters, filters), and
message-arrival polish. Each workstream is sized for one session.

## Baseline (probed 2026-07-23, code audit)

- **Lightbox** (`chat/src/components/image-lightbox.tsx`): fixed overlay, Esc /
  click-to-close only. No zoom, no pan, no pinch, no open/close transition.
  Opened via delegated click in `message-row.tsx` (images only; emoji/sticker
  excluded).
- **Media**: AMS images/video proxied via `/api/teams/media` (content-type gate
  allows `image/*` + `video/*`; whole-blob fetch, **no Range support**). Inline
  `<video>` tags render the native player in the bubble but never enter the
  lightbox. Files/recordings are link-out chips to SharePoint (t141/t162 —
  inline recording playback deliberately rejected, memory bomb). No explicit
  download affordance anywhere.
- **User info**: Graph `getByIds` parses `displayName` only; `users` table
  stores `mri → display_name`. Avatars proxied (`/api/teams/avatar`, t153).
  Sender name/avatar in `message-row.tsx` is **not clickable**; no profile
  dialog exists.
- **Mute** (t156): `conversation_prefs.muted` boolean, local-only. Muted row is
  dimmed `opacity-60`, bell-off glyph **replaces the unread dot** (mute wins
  over unread), and the t147 push sweep is not mute-aware per conversation.
  No mute-for-period, no notify-on-mention override. Teams API exposes **no
  per-chat mute** on the conversation object (probed t147).
- **Conversation row**: unread = coral dot far right next to timestamp +
  semibold title. Avatar (single or facepile) has no indicator. No custom
  titles (only Teams topic). No mention counter. No unread/mention filters
  (only t156 folders). `relativeTime` renders once — **stale until the next
  poll merge** (no interval tick).
- **Messages**: `rounded-2xl` bubbles, t158 same-sender grouping,
  `data-density` compact mode. Poll merge (`message-merge.ts`) appends new
  messages **all at once** — no stagger, no animation lib in `chat/`
  (`motion` is already installed at the repo root for the `/` build).
- **Mentions**: `mentionsMe` per-message flag already computed
  (`core/teams-render.js` `mentionIsSelf`, self oid from `accounts.user_id`).
  No conversation-level mention aggregation.
- **Unread counts**: boolean only (`lastMessageTs > readTs`); no per-conv
  count column; local `messages` table holds only polled pages, so any local
  count is a floor, not Teams' number.

## Guiding constraints

- Web build only; `/` browser build stays byte-unchanged.
- Reuse before adding: `motion` (installed), `canvas-zoom.ts` pinch math
  (`src/lib/`), shadcn `ui/*` primitives. New deps only at a real trigger.
- Local-only writes: custom titles / mute windows / mention prefs live in
  `conversation_prefs` (idempotent `ADD_COLUMNS` migration path exists) —
  never written back to Teams.
- Probe host read-only; sends only to self Notes chat (`48:notes`).

---

## Workstream A — Lightbox v2 (zoom + transitions)

**Goal.** Pinch-to-zoom, scroll/2-finger pan while zoomed, wheel/double-tap
zoom on desktop, smooth open/close animation (scale/fade from the thumbnail).

**Approach.**
- Reuse the pure pinch/pan/clamp model from `src/lib/canvas-zoom.ts`
  (applyPinch/clampToViewport) or extract a shared pure module if its screencast
  coupling is too tight; TDD the zoom state reducer.
- `motion` (already installed) for open/close: animate from the source `<img>`
  rect (layout projection) with backdrop fade; reduced-motion respected.
- Keyboard: Esc close (kept), `+/-/0` zoom, arrows pan when zoomed.

**Acceptance.**
- [ ] Pinch zoom + pan on iPad; wheel/double-click zoom on desktop; zoom-out
      past 1× snaps back to fit.
- [ ] Open/close animates from/to the tapped thumbnail; no layout shift.
- [ ] Esc still closes; click-outside closes only at 1× (else it's a pan).

**Depends on:** nothing. **Blocks:** B (video lightbox reuses the shell).

---

## Workstream B — Media: lightbox for video, downloads

**Goal.** Inline AMS videos open in the same lightbox (native `<video>`
controls); download affordance for images (and video) from the lightbox.

**Approach.**
- Route `<video>` (AMS-proxied) taps through the same delegated handler into
  the lightbox with a `<video controls autoplay>` element.
- Download: same-origin proxy URL means a plain `<a download>` works; button in
  the lightbox chrome (and long-press/context on the inline image).
- PDF/office files stay **link-out** to SharePoint (auth lives in the browser
  SSO session; proxying SharePoint bytes is out of scope — see open questions).
- Note the proxy ceiling: whole-blob, no Range — fine for chat clips, wrong for
  long videos; keep t162's recording link-out untouched.

**Acceptance.**
- [ ] Tapping an inline video opens the lightbox and plays with controls.
- [ ] Download button saves the original bytes with a sensible filename.
- [ ] Recordings/files unchanged (SharePoint link-out).

**Depends on:** A (lightbox shell).

---

## Workstream C — User profile dialog

**Goal.** Click a sender name/avatar (message row, conversation header) →
shadcn Dialog with the fullest profile we can fetch: big avatar, display name,
mail, job title, department, office, phone, + open-DM action.

**Approach.**
- Extend the existing Graph path: `GET /v1.0/users/{oid}?$select=…` on demand
  (new `/api/teams/profile?userId=` endpoint, in-page fetch, same SSRF
  normalization as `/api/teams/avatar`); cache in `users` table (add columns or
  a `profile_json` column via `ADD_COLUMNS`).
- Presence is a separate Graph API + scope — probe at build whether the bearer
  can call it; degrade to omitting the presence row if not.
- Dialog: shadcn Dialog + existing `UserAvatar` at a large size; skeleton /
  error states per four-state convention.
- "Message" action: find-or-open the 1:1 conversation (id is derivable from
  both oids — `19:{a}_{b}@unq.gbl.spaces`) and route to `/chat/c/{id}`.

**Acceptance.**
- [ ] Name + avatar clickable everywhere a sender renders; dialog shows
      fetched fields with loading/empty/error states.
- [ ] Fields cached; reopening is instant, no duplicate Graph hits.
- [ ] Open-DM routes to the existing conversation when one exists.

**Depends on:** nothing. **Parallel with:** A, B, D.

---

## Workstream D — Mute v2 (unread survives, mute-for-period, mention override)

**Goal.** Muting only silences *notifications*: unread indicator still shows;
optional timed mute (presets); optional "still notify when mentioned".

**Approach.**
- Schema: `conversation_prefs` gains `muted_until` (epoch ms; null = forever
  when `muted=1`) and `notify_on_mention` (bool) via `ADD_COLUMNS`.
- List rendering: unread dot/semibold render regardless of mute; mute shows as
  the bell-off glyph *alongside*, not instead (exact layout per E's indicator
  move). Expired `muted_until` reads as unmuted (pure predicate, TDD).
- Push path: the t147 notify sweep consults prefs before emitting — skip when
  muted-now, unless `notify_on_mention` and the message's `mentionsMe` is true
  (flag already computed server-side).
- UI: context menu + ⌘K get a mute submenu (For 1 hour / 8 hours / 24 hours /
  Until I unmute — presets pending grill) + "Notify me on mention" toggle.

**Acceptance.**
- [ ] Muted conversation still shows unread state; push stays silent.
- [ ] Timed mute auto-expires (no timer needed — predicate on read).
- [ ] Mention in a muted chat pushes when the override is on; live-verified
      against the real sweep (self-mention in Notes or fixture).

**Depends on:** nothing (E only for final indicator placement). t147 sweep is
the integration point.

---

## Workstream E — Conversation row v2

**Goal.** Avatar-anchored unread indicator (no layout shift), custom local
chat titles, unread-mentions indicator, unread/mentions filters, live "ago"
times.

**Approach.**
- **Indicator on avatar**: coral dot as an absolutely-positioned badge on the
  avatar box corner (single avatar and facepile share one fixed `size-10` box,
  so one overlay position works for both); remove the right-side dot; the
  right column keeps timestamp only. Pure row-state selector TDD'd.
- **Custom title**: `conversation_prefs.custom_title` (`ADD_COLUMNS`);
  rendered as the row/header title with the original resolved title beneath in
  smaller muted text. Edit via context menu + ⌘K ("Rename chat"). Search/⌘K
  jump matches both names.
- **Mention indicator**: `@` badge when the conversation has unread messages
  with `mentionsMe` — computed from the local `messages` table
  (`ts > readTs AND mentions_me`), which needs `mentions_me` persisted as a
  message column at upsert (today it's render-time only). Count is a floor
  (local pages only) — display form pending grill (`@` boolean vs number).
- **Filters**: segmented control (All / Unread / Mentions) above the list,
  composing with folders; pure predicate in `conversation-view.ts`;
  keyboard + ⌘K accessible; j/k walks the filtered order.
- **Live "ago"**: one list-level 30s interval tick re-rendering timestamps
  (single timer, not per-row).

**Acceptance.**
- [ ] Unread/mute/mention state never shifts row layout (indicator lives in
      the avatar box; time column width stable).
- [ ] Custom title shows with original-as-subtitle; survives restart; both
      names searchable.
- [ ] Mentions filter shows exactly conversations with unread self-mentions.
- [ ] Times tick without a poll.

**Depends on:** D (mute glyph placement decided together), mention persistence
shared with D's sweep override.

---

## Workstream F — Message polish (radius + staggered arrival)

**Goal.** Tighter bubble geometry in compact density; when a poll delivers
several new messages at once, reveal them one-by-one so the eye can track.

**Approach.**
- Radius: audit bubble radius at both densities; compact gets a smaller token
  (e.g. `rounded-xl`) and grouped same-sender runs get asymmetric corners
  (first/middle/last) — token-level change, no component fork.
- Stagger: `message-merge.ts` already returns the changed set; thread-view
  wraps *newly appended* rows in a `motion` presence with a small per-index
  delay (~80–120ms, capped so a 20-message burst doesn't take seconds);
  scroll-stick logic follows the last revealed row. Own optimistic sends never
  stagger. Reduced-motion disables it.

**Acceptance.**
- [ ] Compact density bubbles read visibly tighter; grouped runs have
      asymmetric corners; light+dark verified.
- [ ] 3 simultaneous new messages animate in sequentially; burst cap works;
      no scroll jank; `prefers-reduced-motion` honored.

**Depends on:** nothing. **Parallel with:** all.

---

## Workstream G — Bug sweep + live verification (last)

Full pass over A–F against the live host: light/dark, comfortable/compact,
desktop/iPad PWA, keyboard-only, reduced motion. Fix regressions; screenshots
per surface in the Linear comment.

---

## Dependency / parallelism table

| Workstream | Depends on | Parallel with |
|---|---|---|
| A Lightbox v2 | — | C, D, F |
| B Media lightbox + download | A | C, D, E |
| C Profile dialog | — | A, B, D, F |
| D Mute v2 | — (E for layout) | A, B, C, F |
| E Row v2 | D (indicator layout), shares mention persistence | A, B, C |
| F Message polish | — | all |
| G Bug sweep | A–F | — |

Suggested order: A → B, C, D in any order → E → F → G.

## Risks

- **Mention counts undercount**: local DB only has polled pages; Teams has no
  per-conv mention API we call. Mitigate by showing presence (`@`) not
  arithmetic, or labeling the count as local (grill Q4).
- **Presence/profile Graph scopes**: the in-page bearer may lack scopes for
  some `$select` fields or presence; probe at C's pickup, degrade gracefully.
- **Stagger vs scroll-stick**: animated heights can fight `flex-col-reverse`
  stick-to-bottom; cap + reduced-motion + G's sweep cover it.
- **Video downloads via whole-blob proxy**: a large video buffers fully in
  server memory; keep the existing behavior (only AMS chat clips proxied) and
  don't extend to recordings.

## Out of scope

- Adaptive-card interactive render (`adaptivecards`) — unchanged trigger rule.
- Inline SharePoint/PDF preview (auth + bytes proxying; link-out stays).
- Teams-side mute/favorite sync (API doesn't expose it — probed t147).
- Unified push pipeline merge (separate task).
- Electron chat shell.

## Open questions (grill)

Tracked in the Linear grill comment; folded back here as **Decisions** after
answers.
