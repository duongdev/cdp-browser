# 064 — slack notifications: support multiple workspaces

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** none

## Goal

Add Slack as a third Notification Adapter (alongside Teams + Outlook), so notifications
from Slack workspaces open in CDP Browser surface in the bell/sidebar like the others.
Unlike Teams/Outlook — which scrape an in-app toast node — Slack has no in-app toast, so
the adapter captures by **intercepting the Web Notifications API** (`window.Notification`)
in the page. Multiple Slack workspaces (one tab per workspace) are each bucketed
separately by a `slack:{teamId}` group key, so per-workspace unread counts stay distinct
even though every workspace shares the `app.slack.com` origin.

## Why now

Slack is a daily-driver app for the operator; notifications are the headline feature of
the side-channel and Slack is the biggest gap. The Notification Adapter seam (name +
script + match + iconUrl, plus the `groupKey`/`activate` hooks) was built to be a drop-in;
this is the first adapter that exercises the per-workspace `groupKey` split the infra
already anticipates (`core/notifications.js` comment: "a future adapter can emit
`slack:{teamId}` to split workspaces with no consumer change").

## Acceptance criteria

- [ ] A Slack tab (`*.slack.com`) gets a read-only side-channel attached, like Teams/Outlook.
- [ ] A real Slack mention/DM produces a notification entry in the bell + sidebar.
- [ ] Capture works regardless of the remote browser's notification-permission state
      (the injected script forces `Notification.permission` → `"granted"`).
- [ ] With ≥2 Slack workspaces open (one tab each), unread counts are bucketed
      per-workspace (`slack:{teamId}`), not merged under one `app.slack.com` badge.
- [ ] The notification entry shows the workspace name (not the raw teamId) as its group label.
- [ ] Clicking a Slack notification activates that workspace's tab; when a channelId is
      extractable, it also SPA-navigates to that channel. Otherwise tab-only activation.
- [ ] Headless (web build) and Electron both capture identically (shared `core` + `inject`).

## Test plan

### Layer 1 — Pure logic (TDD)

- [x] `parseSlackContext(url)` (pure, `core/notifications.js`) — extracts
      `{ teamId, channelId }`; `E`/`T` team ids; `C`/`D`/`G` channels; legacy
      `acme.slack.com` subdomain fallback; non-Slack / `slack.com.evil.com` / malformed → nulls.
- [x] `slackGroupKey(url)` (pure) — `slack:{teamId}`; empty/unknown → "" (unkeyable).
- [x] Slack adapter `groupKey(url)` hook wired into `handleToast` — derives per-workspace
      key server-side from the Tab URL; two workspaces on `app.slack.com` stay distinct.
- [x] `unread-aggregator` (renderer) — a Slack tab/pin resolves to its `slack:{teamId}`
      bucket (not the shared origin), so sidebar badges are non-zero and per-workspace
      (the blocker the adversarial review caught: byTab/byPin keyed on origin while byGroup
      keyed `slack:{teamId}` → all Slack badges read 0). Fixed via shared `groupKeyForUrl`.

### Layer 2 — Manual smoke (CDP/IPC) — HITL against <remote-browser-host>:9222

- [ ] Slack tab open → side-channel attaches (verify in logs / notification appears).
- [ ] Send self a DM/mention in workspace A → entry appears with workspace-A label.
- [ ] Open a second workspace in another tab, trigger a notification → distinct bucket.
- [ ] Click the entry → workspace tab activates (+ channel nav when channelId present).

### Layer 3 — Visual review

n/a — no new renderer UI; reuses the existing bell/sidebar/notification surfaces.
Existing notification components render Slack entries unchanged (icon + group label).

## Design notes

Mirrors the Teams/Outlook adapter pattern; only the capture mechanism differs.

- **Contracts changed:**
  - `ADAPTERS` (`core/notifications-sidechain.js`) — add a `slack` entry
    (`match: *.slack.com`, `script: "slack-notify.js"`, `iconUrl`).
  - `ActivateIntent` (`src/lib/notification-activation.ts`) — reuse `spa-link` for the
    channel deep-link (the URL `/client/{team}/{channel}` is a real SPA route); no new
    variant unless live validation shows the SPA route needs a custom handler.
- **New modules:**
  - `inject/slack-notify.js` — Notification-API hijack capture script (DOM/page glue).
  - A small pure Slack-context parser (`parseSlackContext`/`slackGroupKey`) — placement
    TBD by implementer (a `core/` pure helper or inline-tested module), under TDD.
- **New ADR needed?** No — this is a new adapter inside the existing ADR-0003
  (notifications side-channel) seam, not a new architectural decision.

### Validated live findings (spike against <remote-browser-host>:9222, 2026-06-03)

- URL shape: `app.slack.com/client/E0EXAMPLE01/C0EXAMPLE01`. teamId regex
  `/client/([TE][A-Z0-9]+)/` works (Enterprise Grid `E` prefix confirmed); channelId is
  the next `C…` path segment.
- `Notification.permission` was `"default"` on the live tab → **permission override is
  mandatory** or Slack never calls `new Notification`.
- Workspace name: DOM anchor `.p-ia4_home_header_menu__team_name` →
  "Example Group Holdings Limited" (clean). Fallback: `document.title` split on
  " - " (workspace name is a middle segment), then hostname.
- Capture must patch `window.Notification` at **document-start** (Slack caches the
  original ref at load), exactly like the existing adapters inject via
  `Page.addScriptToEvaluateOnNewDocument`.

```ts
// pure context parser (shape, not path)
parseSlackContext(url: string): { teamId: string | null; channelId: string | null }
slackGroupKey(ctx: { teamId: string | null }): string   // "slack:E0EXAMPLE01" | ""

// capture payload shipped via __cdpNotify (matches existing adapters)
{
  id: `slack:${teamId}:${ts}:${seq}`,   // unique-per-fire — no tag/content keying
  source: senderOrTitle,
  title, body,
  groupKey: `slack:${teamId}`,
  activate: channelId ? { type: "spa-link", url: `/client/${teamId}/${channelId}` } : null,
  workspaceName,                          // best-effort display label
  ts,
}
```

## Out of scope

- Exact-message scroll (`/archives/{channel}/p{ts}`) — deep-link stops at the channel (v0.2).
- Capturing notifications from a workspace that's been switched-away-from inside a single
  tab (its JS isn't running) — the model is one tab per workspace.
- Activity-view / thread / sidebar-badge scraping — capture is Notification-API only.
- Link unfurls / rich notification metadata.
- Slack as a local-tab (`persist:local`) integration — this is CDP-screencast side-channel only.
- Service-worker `push`-handler notifications (`self.registration.showNotification` in the
  SW realm) — unreachable from a page-injected script; the live remote tab's in-page
  `window.Notification` path (the steady state) is what's captured. Capturing SW-push would
  need a side-channel attached to the `service_worker` target. (Review finding, deferred.)

## Definition of Done

- [ ] Layer 1 tests written and green
- [ ] Layer 2 smoke checklist completed with a live Remote Browser
- [ ] Layer 3: n/a (no new UI)
- [ ] `pnpm check` clean (changed files)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm dev` (and `pnpm web`) boot cleanly and Slack notifications work end-to-end
- [ ] CLAUDE.md updated (adapter list, inject/ list, notifications-sidechain bullet)
- [ ] No commented-out code, no console.log debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t064 in commit

## Notes

- Decisions locked via /grill-me (2026-06-03): (1) Notification-API hijack capture;
  (2) one tab per workspace; (3) `groupKey: slack:{teamId}`, best-effort workspaceName;
  (4) activation = tab + best-effort channel SPA-nav, degrade to tab-only;
  (5) unique-per-fire dedup id; (6) force `Notification.permission` → granted.
- The exact Slack `Notification` `data`/`tag` shape (for channelId deep-link) was not
  captured in the spike (late patch missed Slack's cached ref). The doc-start-injected
  real script must be validated live (HITL) — extract channelId defensively from
  `opts.data` common keys, degrade to tab-only if absent.

---

_When task status flips to `done`, move this file to `done/`._
