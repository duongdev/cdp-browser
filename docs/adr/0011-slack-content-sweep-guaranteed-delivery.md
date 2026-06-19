# ADR-0011: Slack content sweep — guaranteed-delivery notification capture

- **Status:** Accepted (all phases shipped t066–t074, validated live 2026-06-11)
- **Date:** 2026-06-11

This ADR records a **design ratified by a grilling session** (decisions below are settled), to be broken into tasks. It is targeted after the v0.1.0 Web Push hardening, and composes with — does not block — ADR-0010 (multiple workspaces): every entry already carries a workspace key.

## Context

Slack notifications go missing. The existing Slack capture (ADR-0003, t064) is a single modality: an injected `window.Notification` hijack in the live remote tab. It only sees what Slack *chooses to fire*, and Slack suppresses firing in exactly the situations the user hits daily:

- **Native macOS Slack app open** — Slack routes desktop notifications to the most-recently-active client; the remote web tab goes silent and the hijack never runs.
- **Remote tab focused/visible** — every client connect calls `/json/activate`, so the last-viewed tab is the remote browser's active tab; a focused remote window makes Slack see `visible + hasFocus()` and not fire.
- **Presence/typing suppression, DND, schedules** — Slack's own gating.
- **Tab sleep / tab closed / server gap** — no live page means no hijack.

Teams and Outlook are less affected (their adapters scrape in-app toast DOM, which renders regardless of OS-notification routing). Slack is the worst because it has no in-app toast and the most daily volume.

The hijack is a *client-presence* signal. The fix is to also read Slack's **authoritative server-side unread state** — the same state Slack's own clients reconcile against — so completeness no longer depends on the page choosing to fire.

## Decision

Add a **second, authoritative capture modality for Slack: a server-side content sweep** that reads Slack's real unread state via Slack's web API using the page's own extracted session, synthesizes notification entries, and owns the persisted Slack store. The page hijack is demoted to an instant-toast-only fast path. Settled decisions:

1. **Sweep scope = Slack-parity + excludes.** The "must never miss" set is what Slack itself would notify: DMs, group DMs, channel mentions (incl. `@here`/`@channel`), and unread thread replies. A user exclude list silences specific channels on top.

2. **Home = server-side with extracted creds.** The web server (`web/server.mjs`) polls Slack directly. This is the only home that survives tab closure, tab sleep, native-app routing, and focus suppression — the entire failure class — because it does not depend on a live page firing anything.

3. **Cred source = CDP extraction from a live tab.** On reconcile, the side-channel pulls the `xoxc-…` token (from the page's `localConfig`/boot data via `Runtime.evaluate`) and the `d` cookie (`Network.getCookies`). Zero manual setup. Creds refresh whenever a workspace tab is live.

4. **Path model = sweep owns the store; hijack = instant toast only.** The sweep is the single writer of persisted Slack entries, keyed by **stable Slack message identity** `slack:{team}:{channel}:{ts}`. Store-level id dedup (the existing `ingest` existing-id guard) makes re-emits idempotent — a re-seen message just no-ops. The hijack still fires the sub-second foreground toast but **no longer writes Slack entries to the store**, so there is no fuzzy cross-path dedup (the two id schemes never had to be matched). This **changes the Slack entry id scheme** from the hijack's wall-clock `slack:{team}:{Date.now()}:{seq}` to the message-anchored key.

5. **Parity fidelity = counts-driven baseline + muted + excludes.** Trust `client.counts` (DM/group-DM unreads, per-channel mention counts, thread-reply counts). Honor Slack's muted-channel flag. Apply the user exclude list. No per-channel-pref / highlight-word parsing (brittle, undocumented) in v1.

6. **Read sync = follow Slack `last_read`.** Each poll reads per-channel `last_read` from `client.counts`; entries older than `last_read` auto-flip to read. Reading on any Slack client (phone, native, web) clears our badge too. No extra API cost.

7. **Cred staleness (401 `invalid_auth`) = degraded health + parked tab.** On 401 with no live tab to re-extract, mark the workspace **capture-degraded** in the health surface and push a one-time "reconnect Slack" alert. The server keeps **one parked Slack tab per registered workspace** alive on the remote browser so creds self-refresh and the hijack stays armed — closing the visible tab never blinds the sweep.

8. **Parked-tab scope = keep-alive known workspaces, recreate if gone.** A workspace seen live once is persisted in a **workspace registry** (`teamId → { url, creds, lastSeen }`). The server ensures exactly one tab per registered workspace exists, recreating via `/json/new` if closed or after a browser restart. New workspaces are still added by the user opening them once. (Trade-off accepted: parked tabs may visibly reappear after being closed.)

9. **Excludes = mute-from-entry + Settings list, server-stored.** Each notification carries a "Mute this channel" action; the muted `{ team, channelId, label }` list is also editable in Settings. Stored in **server ui-state** (survives the iPad PWA's localStorage wipe — see memory `localstorage-resets-in-pwa`). Channel id is the stable key; label is shown.

10. **Content render = resolve names + best-effort mrkdwn, cached.** Title `"{sender} in {channel}"` (DM: just sender); body = message text with `<@U…>` → `@name` and basic mrkdwn stripped. A per-workspace user/channel map is cached and lazily filled via `users.info`. Reads like a real Slack notification.

### Shape

- **`core/slack-sweep.js`** (new, pure + DI, backend-agnostic CJS): the watermark/parity reducer. Given `client.counts` + fetched history + per-channel watermark + exclude list, returns the set of new entries to ingest and the read-state updates. No I/O — the server injects the Slack API client, the clock, and the store. Mirrors the pure-reducer / effects-in-caller pattern of `core/notifications.js`.
- **`core/slack-api.js`** (new): the effectful Slack web-API client (auth via `xoxc` + `d` cookie), rate-limit aware, used only by the server. Methods: `clientCounts`, `conversationsHistory`, `usersInfo`. Cred-injected.
- **Workspace registry + parked-tab keeper**: server-side persistence (`slack-workspaces.json` next to the settings file) + a keep-alive loop folded into the existing 5s reconcile.
- **Slack adapter changes** (`notifications-sidechain.js`): the hijack capture script stops shipping store entries (becomes toast-only signalling); the adapter gains a `sweep` hook so the design stays one config entry per site.
- **Health surface**: `/api/notifications/health` — per workspace: side-channel attached, hijack armed, creds fresh/stale, last sweep ok, last entry ts. Drives a Settings row and disambiguates "never fired" from "lost downstream".

## Consequences

**Easier:**
- Slack notifications become **complete** independent of native-app routing, tab focus, tab sleep, tab closure, or server downtime gaps (caught up on next poll via the watermark).
- Badges stay honest across all Slack clients (read sync).
- Entries are message-anchored, so dedup across restarts/reconnects is free.
- The health surface makes capture failure visible instead of silent.

**Harder / costs:**
- **Slack creds (`xoxc` token + `d` cookie) now live on the server** at rest (in the workspace registry). This is a real security surface — it must inherit the same trust boundary as the existing settings/notifications files, and is a TOS grey area (uses Slack's internal web API, same as the official client, but not a published integration).
- The server now **provisions tabs** on the remote browser, not just observes them — a new side effect with visible consequences.
- Rate-limit discipline and token-rotation handling add lifecycle code.
- Two capture modalities for one site (sweep + hijack) is more moving parts than t064's single hijack — justified only because the single modality demonstrably misses.

## Alternatives

- **In-page sweep via the side-channel** (page fetches with its own session via `Runtime.evaluate`; no creds at rest). Cleaner security posture, but a closed/sleeping tab still blinds it — exactly the failure class we must close. Rejected as the primary; the parked-tab keeper plus server-side creds is what makes "tab closed" survivable.
- **Web Push hardening alone** (`pushsubscriptionchange` handler, per-device toggle, re-subscribe on launch, retry). Necessary and shipped separately, but it only fixes the *delivery* leg — it can't recover a notification the hijack never captured. Orthogonal, not a substitute.
- **Dual-write + fuzzy dedup** (both paths write, reconcile by channel + body-prefix + time window). Risks both double entries and wrongly merging two quick messages, because the hijack lacks the message `ts`. Rejected for the single-writer model.
- **Sweep-only, drop the hijack.** Simplest, but loses the sub-second real-time toast. Kept the hijack as a toast-only fast path instead.
- **Full prefs parity** (parse `users.prefs` + per-channel notify prefs + highlight words). Brittle against undocumented shapes for marginal gain over the counts-driven baseline. Deferred.

## Implementation notes (amendments discovered during build)

- **No creds on disk (amends decision 8).** The build found the `d` session cookie is shared
  across all of a user's workspaces and `localConfig_v2` carries every team's xoxc token, so a
  single live Slack tab refreshes creds for **all** workspaces. The workspace registry
  (`slack-workspaces.json`) therefore persists **only non-secret metadata** (`teamId → { url,
  name, lastSeen }`); creds live in memory and re-extract from any live/parked tab within one
  reconcile cycle on restart. This is strictly safer than the sketched creds-at-rest and removes
  the cleanup burden — the only persisted Slack file is the non-secret registry.
- **Registry scope = own-tab workspaces.** A workspace is registered (and thus parked-tab-kept)
  only when seen as **its own tab**, not for every team in `localConfig_v2`. Enterprise Grid child
  workspaces accessed through a parent tab are still **swept** (their token is in localConfig) but
  not given a dedicated parked tab — avoids spawning tabs the user never opened.
- **Hijack → "sweep now" trigger (refines decision 4).** Rather than the demoted hijack writing a
  toast-only entry (which would double-notify against the sweep with no shared id to dedup on), a
  fired Slack hijack notification triggers an **immediate sweep** of that workspace. The sweep stays
  the sole writer/pusher; delivery is sub-second (triggered, not polled) with message-anchored
  dedup and no double-notify. A 15s periodic sweep is the completeness backstop; cred-extraction
  also triggers an immediate catch-up sweep.
- **First-sweep seeding.** The first sweep of a workspace baselines the watermark from each
  conversation's current `latest` and emits **nothing** — pre-existing unreads (already seen on
  another client) don't spam; only messages arriving after watching-starts notify.
- **~~KNOWN LIMITATION~~ RESOLVED (t075) — Enterprise Grid restricted workspaces.** Some Grid
  **child** workspaces return `team_is_restricted` from `client.counts` (org policy). Live probing
  found this is **not** a blanket block — `auth.test`, `conversations.list`, and **`users.counts`**
  (the legacy counts endpoint) still work. So t075 adds a **`users.counts` fallback**: when
  `client.counts` is restricted, the sweep reads `users.counts` instead, normalized into the same
  shape. `users.counts` lacks `last_read`/`latest`, so the restricted path **seeds the watermark to
  "now"** (no history fetch, no cold-start spam) and **read-syncs via the unread-set** (an entry
  whose channel is no longer unread flips to read); mute comes from per-channel `is_muted`. Verified
  live against FWD's child workspace TGFUQ89E1 — now reports **healthy**, seeds 51 convos, and
  produces rendered notifications. A workspace is only marked unsweepable (hijack fallback) if
  `users.counts` *also* fails. No creds file needed — extraction covers it.

## Phased breakdown (tasks)

Ship the failure-class fix in delivery order; each phase stands alone and is independently useful.

1. **Web Push hardening** (independent, do first). `pushsubscriptionchange` handler in `sw.js`; re-subscribe + re-POST on every PWA launch when `webPush` is on; one retry for transient push failures; per-device toggle instead of the global `webPush` flag; raise/partition the 50-entry cap. Fixes the delivery leg regardless of the sweep.
2. **`core/slack-api.js`** — effectful Slack web-API client (cred-injected, rate-limit aware): `clientCounts`, `conversationsHistory`, `usersInfo`. Hermetic test against a fake Slack host (mirror `test/e2e` fake-CDP pattern).
3. **`core/slack-sweep.js`** — pure watermark/parity reducer (TDD): counts + history + watermark + excludes + `last_read` → `{ newEntries, readUpdates }`. Stable `slack:{team}:{channel}:{ts}` ids.
4. **Cred extraction** — side-channel pulls `xoxc` token + `d` cookie on reconcile; 401 → mark workspace creds stale.
5. **Workspace registry + parked-tab keeper** — persist `slack-workspaces.json`; keep one tab alive per registered workspace on the 5s reconcile loop; recreate via `/json/new`.
6. **Wire the sweep into the server** — fold into the reconcile loop; sweep becomes the Slack store writer; demote the hijack capture script to toast-only.
7. **Channel Exclude** — server ui-state list; "Mute this channel" entry action + Settings list.
8. **Content render** — name resolution + best-effort mrkdwn, per-workspace cached user/channel map.
9. **Health surface** — `/api/notifications/health` + Settings row (attached / armed / creds fresh / last sweep / last entry).

## Note — Enterprise Grid org/workspace dedup by `enterprise_id` group (2026-06-19, t092)

In an Enterprise Grid, Slack registers the **org itself** as a pseudo-team (an `E…`-prefixed
team with `enterprise_id: null`) *alongside* its member workspaces (each carrying that
`enterprise_id`), and the org token surfaces the same channels the member workspace does.
The sweep treats every team in `localConfig_v2` as an independent capture target keyed
`slack:{teamId}:{channel}:{ts}`, so a message in a channel reachable from both the org and a
workspace was captured **twice** (different team prefix → different id → the `ingest` id-dedup
couldn't catch it) — two notifications, two web-pushes, two health rows. Live evidence (FWD):
org `E0761H36LHY` (27 channels via `client.counts`) ⊂ member workspace `TGFUQ89E1` (51 channels,
`client.counts`→`team_is_restricted`→`users.counts`), overlap 27; standalone `T01CDUT3CBD` (22)
genuinely separate.

**Decision:** group all teams sharing an `enterprise_id` under ONE logical workspace key —
`groupId = enterprise_id || teamId` (`core/slack-creds.js`). The sweep entry id + `groupKey`
key by `slack:{groupId}` so the org+workspace duplicate collapses via the **existing** ingest
id-dedup; the concrete `teamId` (the workspace it was swept from) stays on the entry for
activation / the `/client/{teamId}/{channel}` SPA deep-link. `core/notification-health.js`
`buildHealth` merges creds by `groupId` into one row per org (label = the friendlier member
workspace name when present, else the org name; status = `healthy` if **any** member sweeps via
`client.counts`, carrying `enterpriseId` + the constituent `teamIds`), and `/api/notifications/health`
also returns a `teamId → groupId` map (`buildSlackGroups`) so the renderer can resolve a Slack
Tab/Pin URL (which carries only a `teamId`) to its merged unread/health/mute bucket. The registry
(`core/slack-workspaces.js`, `slack-workspaces.json`) persists `enterpriseId` so a cold start knows
each workspace's org. A standalone team (no `enterprise_id`) is **byte-unchanged**: `groupId ===
teamId` everywhere. `main.js` (Electron, no sweep/creds) keeps the per-`teamId` key — acceptable,
since the Grid merge is a web-sweep concern. Chose merge-by-`enterprise_id` over
cross-dedup-keeping-rows and over dropping a team (the latter is lossy — the member workspace is
API-restricted and the org's `client.counts` watermarks are richer for its 27).
