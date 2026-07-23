# PSN-90 — Native chat UI enhancements (plan)

Status: grilled — decisions resolved · plan-only · 2026-07-23
Issue: https://linear.app/withdustin/issue/PSN-90

Turn the `/chat` Teams surface from "functional data spine" into a world-class,
keyboard-first native chat app with a coherent Airbnb-flavoured design system.
This file is the umbrella plan. Each workstream (A–K) is sized to become its own
`build` task, runnable in a **separate session**. Dependencies are called out so
they can be parallelised where safe.

## Where /chat is today (baseline audit)

Read the CLAUDE.md "Teams chat app" section for the full backend/render contract.
Renderer state as of this plan:

- **Design**: reuses the browser renderer's shadcn **radix-nova** theme verbatim
  (`chat/src/index.css` → `@import ../../src/index.css`). No chat-specific design
  system, no Airbnb tokens. Manrope/DM-Mono fonts.
- **Cmd+K**: none. No command palette in the chat app (the `/` browser build has
  one via `hotkey-registry.ts`, not shared into `chat/`).
- **Keyboard**: only composer (Enter/Shift+Enter), lightbox (Esc), edit box
  (Enter/Esc). No global list/thread navigation, no j/k, no arrow traversal.
- **Avatars**: initial-letter tiles only (`conversation-row.tsx`,
  `size-10 avatar` placeholder). No real photos, no thread/participant avatars.
- **Settings**: none in `chat/`. Only `notify-toggle.tsx` (push on/off).
- **Message types**: `core/teams-render.js` `renderBody` — HTML messagetypes keep
  markup (mentions/emoji/media), literal `Text` is escaped, `<URIObject>` cards
  and files degrade to chips, `ThreadActivity/*` is skipped entirely. Anything
  else with non-html messagetype falls back to escaped raw text. **Meeting
  threads are the known weak spot** (call events, scheduling cards, adaptive
  cards, join/leave system messages).

Two-pane layout (`chat-app.tsx`, wide ≥768px), MRU keep-alive thread panes
(`thread-keepalive.ts`), poll-based live sync (`message-merge.ts` 4s /
`conversation-merge.ts` 12s).

## Guiding constraints

- **Web build only.** Electron chat shell is a fast-follow; do not gate work on it.
- **Shared design system stays shared where it should.** The chat app imports
  `src/components/ui/*` + `src/index.css`. An Airbnb re-skin must be done as
  **theme tokens**, not a fork, or it diverges the `/` browser build. Re-skin is
  **chat-only** (grilled #1).
- **No new heavy deps without a real trigger** (chat-ui-lib research in
  CLAUDE.md: DOMPurify ✓ already in; react-virtuoso / frimousse / adaptivecards
  only at their trigger).
- **Probe, don't mutate.** Teams host `100.85.206.8:9222` is read-only for other
  people's threads; only the self **Notes** chat (`48:notes`) may receive sends.

---

## Workstream A — Airbnb-flavoured design system (foundational)

**Goal.** A named token layer the chat app renders through, matching the warmth
of `~/Downloads/DESIGN-airbnb.md` (generous whitespace, single soft shadow tier,
pill/rounded geometry, modest weights) without breaking the `/` browser build.
Decisions: chat-only scope, keep Manrope, **subtle accent — not full Rausch**
(warmth from space/geometry/shadow; accent reserved for focus, unread, own-message
tint).

**Approach.**
- Define a chat-scoped theme (e.g. `chat/src/theme.css` layered after the shared
  import, or a `data-app="chat"` scope) mapping the existing shadcn CSS vars to
  the Airbnb-flavoured values: subtle accent, radius scale, one elevation shadow,
  hairline borders, surface-soft. Keep the same variable names so `ui/*`
  components inherit — no component forks.
- Map the design spec's type ramp onto Manrope. Spacing/rounded scale → Tailwind.
- Re-skin the primitives the chat actually uses: message bubbles, conversation
  rows, composer, buttons, skeletons, list/thread headers.

**Acceptance.**
- [ ] Chat renders with the subtle accent + Airbnb geometry; `/` browser build is
      byte-unchanged (verify via a screenshot diff / manual check).
- [ ] Tokens are documented (one short table) and referenced by name, not inline.
- [ ] Light + dark both covered.
- [ ] No new component forks of `ui/*`.

**Depends on:** nothing. **Blocks (visually):** B, D, E, F polish. Ship first.

---

## Workstream B — Context-aware Cmd+K command palette

**Goal.** A ⌘K palette whose actions change with context (viewing list vs a
thread vs composing): jump-to-conversation (fuzzy over conversation list),
message actions (react/edit/delete on the focused message), thread actions
(mark read, open in browser), app actions (settings, toggle push).

**Approach.**
- Port the `/` build's pattern: a pure action registry (mirror
  `src/lib/hotkey-registry.ts`) → `chat/src/lib/command-registry.ts`, effects
  injected by `chat-app.tsx`. Presentation via `cmdk` (already a dep of the
  shared `ui/`).
- Context comes from current view + focused message id (see C for focus model).
- Fuzzy conversation search reuses the diacritic-safe fold (`src/lib/fold-text.ts`).

**Acceptance.**
- [ ] ⌘K opens; actions filter by context (list vs thread vs message-focused).
- [ ] Jump-to-conversation switches panes instantly (keep-alive).
- [ ] Keyboard-only operable, Esc closes, no mouse required.

**Depends on:** C (shared focus model + hotkey plumbing) — build C's registry
first or co-design. **Parallel with:** A (functional), E, G.

---

## Workstream C — Keyboard-first navigation (Linear-style)

**Goal.** Full keyboard operation matching Linear's model: `j/k` or `↑/↓` move
the conversation list / message focus, `Enter` opens/sends, `Esc` backs out,
`g` then key for go-to, `?` opens a shortcut cheat-sheet overlay, `e`/`⌫` for
edit/delete on own focused message, `r` to react.

**Research (do at pickup, /grill-with-docs).** Pull Linear's actual shortcut map
+ Superhuman/Slack keyboard models; codify a chat-appropriate subset. Record as
a short doc before coding.

**Approach.**
- A single focus model: `focusedConversationId` + `focusedMessageId` in
  `chat-app.tsx`, driven by a keydown router (pure predicate module, mirror
  `src/lib/key-routing.ts`), never fighting the composer (guard when a
  text field is focused).
- A `?` overlay auto-generated from the registry (mirror `shortcut-overlay.tsx`).
- Visible focus ring + scroll-into-view on focus move.

**Acceptance.**
- [ ] List + thread fully navigable without a pointer.
- [ ] Shortcuts don't fire while typing in composer/edit/search.
- [ ] `?` overlay lists every binding, grouped.
- [ ] Focus is always visible and scrolled into view.

**Depends on:** A (focus-ring styling). **Tightly coupled to B** (shared registry
— design the registry once, consumed by both). Recommend **B+C as one session**
or C's registry first.

---

## Workstream D — UI bug hunt + world-class polish

**Goal.** Find and fix the rough edges; make it feel pixel-perfect and never
janky (product.md bar). This is a **review-then-fix** workstream, not a blind
rewrite.

**Approach.**
- Audit against a checklist per surface (list, thread, composer, media,
  reactions, edit/delete, skeletons, empty/error/loading four-states,
  keyboard/focus, safe-area/iOS PWA, scroll-anchor on load-older).
- Candidate hotspots to verify live: `flex-col-reverse` scroll model edge cases,
  reaction chip reflow, optimistic send/echo dedup flicker, media aspect-box
  reservation, long-message/code-block overflow, mention pill wrapping,
  group-DM title truncation, timestamp grouping, unread/read affordance.
- Each confirmed bug → smallest root-cause fix (fix in the shared pure module
  where all callers route through, not per-symptom).

**Acceptance.**
- [ ] A written bug list (found → fixed / deferred) committed with the work.
- [ ] Four-state coverage verified on every surface.
- [ ] No layout shift on media/reaction/edit; verified with screenshots.

**Depends on:** the UI revamp (grilled #8) — runs **last**, after A + B/C/E/F/I/J/K
land, as the integration sweep.

---

## Workstream E — User avatars

**Goal.** Real participant/sender avatars (photos). Threading is **decided flat**
(grilled #5) — no reply-thread UI, no feasibility gate.

**Feasibility to resolve at pickup.**
- **Avatars.** Teams exposes user photos via Graph
  (`/v1.0/users/{id}/photo/$value`) — reuse the in-page CA-proof fetch + the
  `users` cache (t131). Needs a media-proxy path like AMS (`/api/teams/avatar`)
  with an SSRF guard, and an avatar cache. Confirm the photo endpoint works with
  the existing Graph bearer; fall back to initial tiles (current behaviour).

**Acceptance.**
- [ ] Sender + conversation avatars load real photos (proxied, cached,
      SSRF-guarded); graceful fallback to initials on miss.
- [ ] No layout shift; avatars reserve their box.

**Depends on:** A (avatar sizing/rings). **Parallel with** B/C, D, G.

---

## Workstream F — Settings surface

**Goal.** A chat-app settings sheet. **v1 scope (grilled #4): theme
(light/dark/system) + density/compact mode** — plus the existing push toggle
relocated in. Everything else (send-key, poll cadence, read receipts) waits for a
real ask. Per-conversation notification settings live in workstream K, not here.

**Approach.**
- Reuse the shared shadcn Sheet + the `/` build's settings patterns; persist per
  device in **server ui-state** (never localStorage — it wipes in the iPad PWA;
  see settings-store device-keyed prefixes). A `useChatSettings` hook.
- Keep the surface small; only settings that change real behaviour (ponytail: no
  knobs for values that never change).

**Acceptance.**
- [ ] Theme + density settings persist across a PWA refresh (server ui-state,
      device-keyed).
- [ ] Each setting visibly changes behaviour (density flips row/bubble spacing).
- [ ] Reachable via ⌘K + a header affordance.

**Depends on:** A. **Parallel with** others.

---

## Workstream G — Full message-type support (meeting threads first)

**Goal.** No message renders as raw/garbled data. Especially meeting/call
threads.

**Research (do at pickup — live enumeration).** Over the read-only side-channel,
enumerate **distinct `messagetype` + `properties` shapes** actually present in
the account's meeting threads and busiest chats. Build the support matrix from
real data, not guesses. (Store already captures these server-side; a scripted
`Runtime.evaluate` list of distinct messagetypes is the cheapest source.)

**Known gaps to close (from `teams-render.js`):**
- Adaptive cards (`properties.cards`) — currently `[card]`. **Decision (grilled
  #7): general fallback only** — one styled generic card (title/summary text
  extracted from the payload + an open-in-Teams affordance) for every card type;
  no `adaptivecards` dependency.
- Call/meeting **system events** (`ThreadActivity/*`, call started/ended,
  join/leave, recording available) — currently skipped. Render as compact,
  styled system lines (Slack/Linear-style centered meta rows).
- `RichText/Media_CallRecording` — chip today; consider inline playback (AMS,
  deferred by CLAUDE.md) or a richer recording card.
- Any messagetype falling to the escaped-raw fallback → add an explicit branch.

**Acceptance.**
- [ ] A committed support matrix (messagetype → render treatment) built from
      **live-enumerated** data.
- [ ] Meeting-thread messages render as intentional UI (system lines / cards),
      zero raw payloads.
- [ ] Renderer stays XSS-safe (all HTML through `sanitize-message.ts`).
- [ ] `core/teams-render.js` changes are pure + TDD (mirrors slack-render).

**Depends on:** nothing (backend/pure). **Fully parallel.** Highest independent value.

---

## Workstream I — Persisted routing (added 2026-07-23)

**Goal.** Refresh (or PWA relaunch) lands back in the conversation you were in.

**Approach.**
- URL-based routing, no router lib: path `/chat/c/{convId}` (the server's
  `serveChat` SPA fallback already serves `index.html` for any `/chat/*` path).
  `chat-app.tsx` reads the path on boot → `activeId`; switching conversations
  `history.pushState`s; `popstate` drives back/forward (the phone stacked
  back button becomes a real history pop).
- Unknown/gone convId degrades to the list, never a blank pane.
- Keep-alive panes are unaffected — routing only picks `activeId`.

**Acceptance.**
- [ ] Refresh mid-conversation reopens that conversation (wide + phone).
- [ ] Browser/PWA back-swipe pops thread → list on the phone layout.
- [ ] Deep-link `/chat/c/{id}` opens directly; bad id → list.
- [ ] Push deep-routes (unified-push task, later) can reuse the same URLs.

**Depends on:** nothing. **Fully parallel.** Small, ship early.

---

## Workstream J — Notifications + read/unread polish (added 2026-07-23)

**Goal.** The list tells the truth about what's unread, and notifications feel
first-class.

**Approach.**
- **Unread state.** The store already tracks `read_state`
  (`read_horizon_ts`/`local_read_ts`, monotonic); the list UI shows none of it.
  Surface it: unread rows get weight + accent dot + count where cheap; opening a
  thread clears it (existing local-mark + send write-through unchanged).
  Derivation is pure (`conversation-view.ts`) and TDD'd.
- **Explicit mark read/unread.** Row context/hover action + ⌘K action
  ("mark unread" re-arms the to-do trail — mirror the `/` build's
  mark-unread semantics).
- **Notification polish.** Reuse the existing web-push pipeline; fix rough
  edges found in audit (badge counts vs chat unread, notification tap →
  workstream I's URL, mute honoured — per-conversation mute itself is K).

**Acceptance.**
- [ ] Unread rows visually distinct; count/dot correct against `read_state`.
- [ ] Open thread clears unread; mark-unread re-arms it; both survive refresh.
- [ ] Notification tap deep-routes via I's URL scheme.
- [ ] Pure derivations tested.

**Depends on:** I (deep-route URLs), A (visual tokens). **Parallel with** B/C, E, G.

---

## Workstream K — Labels, folders, per-conversation notification settings (added 2026-07-23)

**Goal.** Organise the conversation list: **local** chat/thread labels, folder
grouping, and per-conversation notification settings. All local to our store —
never written back to Teams.

**Approach.**
- One `conversation_prefs` concept (SQLite table in `teams-store.js`, keyed by
  convId): `labels` (free-form strings), `folder` (one group name), `muted`
  (skip push/badge for this conversation). Server CRUD endpoint; pure list
  shaping (group-by-folder, label chips, filter) in `conversation-view.ts`.
- List renders folders as collapsible sections (ungrouped last); label chips on
  rows; assignment via row context menu + ⌘K.
- Mute gates the push fan-out + unread badge for that conversation (compose with
  J's unread derivation and the existing per-device mute seam).

**Acceptance.**
- [ ] Label/folder/mute assignable from row menu + ⌘K; persist server-side;
      shared across devices.
- [ ] Folder sections group the list; ungrouped conversations still listed.
- [ ] Muted conversation: no push, no unread badge contribution; still readable.
- [ ] Pure shaping tested; no Teams write-back.

**Depends on:** J (unread/mute composition), B (⌘K entries). **After** J.

---

## Workstream H — "Is it world-class?" review pass (cross-cutting)

Not a separate build; a **gate applied inside each of A–G and I–K**: for each area, ask
"is this world-class, what UI mistakes exist, how to improve" and record the
answer in that workstream's PR. Benchmarks: Linear (keyboard/density), Superhuman
(speed/keyboard), Slack/Teams (chat semantics), Airbnb (warmth/whitespace).

---

## Parallelisation summary

| Session | Workstream | Depends on | Notes |
|---|---|---|---|
| 1 | A design system | — | Ship first; unblocks visual polish |
| 2 | G message types | — | Fully independent, backend/pure |
| 3 | I persisted routing | — | Small, independent; ship early |
| 4 | B+C palette + keyboard | A (styling) | Share one registry; do together |
| 5 | E avatars | A | Photo-endpoint probe inside the task |
| 6 | F settings (theme+density) | A | v1 scope fixed |
| 7 | J unread + notifications | I, A | Pure derivation over read_state |
| 8 | K labels/folders/mutes | J, B | conversation_prefs, local-only |
| 9 | D bug hunt + polish | after the revamp lands | Last, catches integration seams |

A, G, and I can start immediately in parallel. B/C, E, F start once A's tokens
land; J after I; K after J; D last (grilled #8).

## Risks

- **Design fork drift.** An Airbnb re-skin done wrong diverges the `/` build.
  Mitigation: token-scoped, no `ui/*` forks, screenshot-diff the browser build.
- **Palette/keyboard registry collision.** Two workstreams inventing separate
  registries. Mitigation: B+C share one, built once.
- **Live message-type coverage is unbounded.** Meeting threads have many event
  types. Mitigation: enumerate from live data, cover the real distribution,
  explicit `[unsupported: type]` dev-only fallback for the long tail.
- **Avatar/Graph auth.** Photo endpoint may need a different scope than messaging.
  Mitigation: feasibility probe first, initials fallback always.
- **iOS PWA + keyboard-first.** Physical keyboard on iPad is the target, but the
  soft keyboard + focus model must not fight the composer.

## Out of scope (this epic)

- Electron chat thin-shell (fast-follow).
- Channel (non-chat) threading if live data shows chats are flat.
- Inline call-recording playback (deferred unless G research flips it).
- Voice/video, presence, typing indicators, message search UI (unless a later task).
- Rewriting the live-sync/poll model (works; not a UI concern).

---

# Phase 2 — polish round 2 (grilled 2026-07-23, comment feedback)

Twelve new items from live usage of t149–t158. Not a new epic — same surface,
same plan; grouped into five workstreams (L–P) below. Baseline facts verified
in code before grouping:

- Grouping (t158) already groups by sender + 5-min window; timestamp renders on
  the group leader only, no hover tooltip (`thread-group.ts`,
  `message-row.tsx:376`).
- Composer **blocks while sending** (`disabled={send.phase === "sending"}`,
  `thread-view.tsx:650`) even though the append is already optimistic; focus is
  not restored after send; media rides the same blocking path.
- Composer renders during history load but is never auto-focused.
- Root is `max-w-6xl mx-auto` (`chat-app.tsx:552`).
- Labels/folders/mutes live in `conversation_prefs` inside `web-teams.db`
  (default path: repo dir, `TEAMS_DB_PATH` env override exists) — a preview
  redeploy replaces the container filesystem, so the DB and all prefs are wiped.
  Not a code bug; a persistence-location problem.
- Recording chip is a dead `<span>`: `parseUriObjects` keeps only
  `url_thumbnail` and drops the URIObject's playback `uri`/inner anchor
  (`teams-render.js:302-321`).
- Mention spans carry no MRI (`<span class="mention">@name</span>`) and the
  client never learns the self oid — "mentions me" needs both.
- `readTs` already reaches the client per conversation (`conversation-view.ts`);
  a last-read separator is pure client-side work.

## Workstream L — Thread reading polish

Items 1, 3, 4, 6, 10.

- **Messenger-style timestamps (1).** Rework `thread-group.ts`: drop the
  per-group inline timestamp; render centered time separators per "turn"
  (sender change after a long gap) and after long idle (Messenger uses ~20 min
  within a day + date separators, which t158 already has). Every bubble gets an
  exact-time tooltip (`title` attr, cheap) — shadcn Tooltip only if `title`
  feels too poor on iPad.
- **Mentions-of-me highlight (3).** `teams-render.js` stamps `data-mri` on
  mention spans (extend the DOMPurify allowlist to keep it); server exposes the
  self oid (it's already in the `accounts` table) on the conversations
  response; renderer adds a `.mention-self` class match → accent-tinted pill,
  plus a subtle full-row tint like Slack's mention background.
- **Scroll-to-bottom FAB (4).** Floating button, visible when not `nearBottom`
  (state already tracked, `thread-view.tsx:261`); shows new-message count while
  scrolled up; click = `scrollTop = 0` (flex-col-reverse).
- **Last-read separator (6).** Pure insert into `buildThreadItems`: a "New"
  hairline after the last message with `ts <= readTs`, computed **once when the
  thread opens** (Slack semantics — it doesn't chase the poll while you read),
  cleared on next open if nothing new.
- **Full-width root (10).** Drop `max-w-6xl`/`max-w-2xl`; list column keeps its
  fixed width, thread pane takes the rest. Message *bubbles* keep a readable
  max-width (~65ch) so ultrawide doesn't produce 300-char lines.

Acceptance: tooltip shows exact time on every message; self-mention visually
distinct (light+dark); FAB appears/works with count; separator matches Slack
behaviour incl. refresh; no horizontal max-width on the app root.

## Workstream M — Composer + send UX

Items 5, 7, 8.

- **Optimistic non-blocking send (7).** Remove the `sending` disable: clear the
  textarea immediately, keep focus (`ref.focus()` after send — and after edit,
  react, image send), let the optimistic bubble carry a pending state; failure
  restores the draft (existing `reduceSend` contract) with a retry affordance
  on the failed bubble instead of freezing the input. Same for image/media
  sends: pending thumbnail bubble, composer stays live.
- **Loading state (8).** While history loads, composer renders enabled +
  auto-focused (wide layout; on touch, no auto-focus — it pops the iOS
  keyboard).
- **Composer redesign (5).** Full visual redesign of the input area: proper
  surface (raised card, hairline border, focus ring), attach + emoji affordance
  placement, send button state, multiline growth, pending-image chips row.
  Design pass against the Airbnb token layer (workstream A). Note: the
  requested `/ui-ux-pro-max` skill is not installed in this agent environment —
  the task will embed the design spec directly (or run under a session where
  the skill exists).

Acceptance: send never blocks typing; focus retained after every send path
incl. media; failed send = inline retry, draft preserved; thread-open shows a
usable focused composer; redesigned composer screenshot-reviewed light+dark.

## Workstream N — Identity display

Items 2, 12.

- **Name display preference (2).** Chat setting (`chat-settings.ts`, device-keyed
  ui-state like theme/density): `full name` (default) | `first name` |
  `custom strip regex` (applied then trimmed; invalid regex → full name).
  Applied at one pure seam (a `displayName(raw, pref)` helper) used by
  message-row sender names, conversation titles, reactor tooltips.
- **Group avatar facepile (12).** Teams-style composite for group chats:
  2 members → two overlapping circles, 3+ → the 2×2-ish cluster Teams shows.
  Extend `listConversations` to carry the first 2–4 member oids (roster already
  fetched for titles, t131); `user-avatar.tsx` grows a `FacepileAvatar` variant
  reusing the existing `/api/teams/avatar` proxy + initials fallback.

Acceptance: pref switches names everywhere live (no reload); bad regex is safe;
group rows show composite member avatars with graceful initials fallback.

## Workstream O — Call recording playback (research-first)

Item 9. `parseUriObjects` drops the playback pointer today — first step is a
live probe of "Trainer Squad Standup" over the read-only side-channel to dump
raw `Media_CallRecording` payloads and see where the video actually lives:

- **AMS-hosted** → parse the `uri` attr, proxy through the existing
  `/api/teams/media` (already video-capable, `isValidAmsUrl`) → inline
  `<video>` playback.
- **SharePoint/Stream-hosted** (newer tenants) → parse the inner anchor href →
  chip becomes a link-out (browser SSO, like file chips). Inline playback of
  SharePoint streams is out of scope (auth'd HLS).
- Either way the chip stops being a dead span.

Acceptance: committed probe notes (payload shape → chosen path); recordings in
that thread either play inline or link out; chip shows duration/title when the
payload carries it.

## Workstream P — Prefs durability (infra, item 11)

Labels/folders/mutes (and all chat state) die with every preview redeploy
because `web-teams.db` lives on the container filesystem. Fix is deployment
config, not code: mount a persistent volume and point `TEAMS_DB_PATH` (and the
settings/ui-state dir) at it. Open decision below — previews are per-branch
apps, so each preview still gets its *own* volume unless they share prod's API.

Acceptance: redeploy of the same app preserves labels/folders/mutes + read
state; documented in the deploy guide.

## Phase 2 open questions (need your input)

1. **Item 11 / P — which surface must keep prefs?** (a) persistent volume on
   **prod** only, previews stay ephemeral (recommended if prod is the daily
   driver); (b) volume per preview app too (each branch still has its own DB);
   (c) previews proxy prefs to prod's DB (shared state, but preview code can
   corrupt prod). Which one — and is your daily driver currently a preview URL
   or prod?
2. **Item 2 — strip regex preset.** Give one real example of your org's display
   name format (e.g. `"Nguyen Van A (EXT)"`) so the default preset actually
   matches; and should the pref be per-device (like theme) or shared?
3. **Item 5 — composer scope.** Visual redesign only, or also new affordances
   (emoji picker, text formatting)? Emoji picker would pull the `frimousse`
   trigger from the chat-ui-lib research.
4. **Item 1 — Messenger gap.** Messenger shows a time separator after ~20 min
   idle; keep 20 min or stay with the current 5-min sender-group window for
   separators too?

Defaults if unanswered: P=(a) prod volume only; 2=per-device, no preset until an
example; 5=visual only; 1=20 min separators, 5 min sender grouping.

## Phase 2 parallelisation

| Session | Workstream | Depends on |
|---|---|---|
| 10 | M composer + send UX | A (tokens) |
| 11 | L thread reading polish | A; L's mention part touches server + sanitizer |
| 12 | N identity display | A |
| 13 | O recording playback | probe first, independent |
| 14 | P prefs durability | infra only, independent — needs Q1 answered |

## Decisions (grilled, 2026-07-23)

1. **Re-skin scope** — `/chat` only. The `/` browser build stays byte-unchanged.
2. **Font** — keep Manrope. No Cereal license.
3. **Accent** — do NOT go full Rausch. Airbnb warmth (whitespace, geometry,
   soft shadow) with a subtler accent; read/unread and own/other contrast win
   over brand voltage.
4. **Settings v1** — theme + density/compact only. More knobs added later on
   demand.
5. **Threads** — flat. No channel-style reply-thread UI. E drops its threading
   feasibility gate; avatars remain its whole scope.
6. **Cmd+K reach** — chat-only palette. No cross into the `/` surface.
7. **Adaptive cards** — no full `adaptivecards` render; a **general fallback**
   (styled generic card: title/summary/open-in-Teams) for all card types.
8. **Bug hunt (D)** — deferred until after the UI revamp lands (A, then B/C/E/F/I/J/K); D runs last as the integration sweep.
