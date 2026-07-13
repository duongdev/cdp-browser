# 105 — dedicated notification capture tab for teams

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** none

## Goal

Notification capture for Teams currently misses every message in the conversation
you are **actively viewing** on the remote browser's foreground tab. Teams (like
most chat apps) suppresses its in-app toast for the conversation that a tab has
open + focused — and the notification side-channel scrapes exactly that toast, so
the message is never captured or pushed. This is worst when the local operator has
walked away (CDP window backgrounded) but the remote Teams tab still looks
"actively viewed" to Teams.

After this task, the Electron build keeps a **dedicated, always-background,
hidden-from-the-Tabs-list Teams capture tab**. Because it is never the foreground
tab and never has a conversation focused, Teams fires its toast for **every**
incoming message — including the one open in the usable tab — so the side-channel
captures it. The tab you actually use is left untouched (normal presence, normal
mark-read); the capture tab is never activated (activating it would re-introduce
the suppression). Notification clicks continue to open/activate the *usable* tab.

## Why now

Daily-driver Teams notifications silently drop messages in the open chat — the
single most-used conversation. A remote-browser assistant (second Electron client
on the same host) misses the same messages. This is the last correctness gap in
Teams capture.

## Verification already done (live, against the real remote Teams — Edge 150)

Empirically confirmed before committing to this design (see Notes for probe logs):

- Teams v2 **allows a second concurrent tab** — no single-instance "open elsewhere"
  parking; both tabs run their notification pipeline.
- A **hidden** tab still renders the `notification-wrapper` toast DOM (~1-2s latency).
- Suppression is **client-side / per-tab** (each tab decides by its own
  `visibilityState` + focused conversation), **not** server-side: at the same
  instant, the focused usable tab showed `wraps=0` (suppressed) while the hidden
  capture tab showed `wraps=1` (rendered + captured) for the same message.
- `window.name` and `sessionStorage` **survive a Teams reload**; a URL query/hash
  marker does **not** (Teams normalizes back to `/v2/`). → mark the capture tab
  with `window.name`.

## Acceptance criteria

- [ ] Electron keeps exactly one live Teams **capture tab** per remote browser
      (created when none is live, recreated if closed), marked `window.name = "__cdpCaptureTab"`.
- [ ] The capture tab is **never** the foreground/active remote tab and is **never**
      activated by tab-switch, notification-click, or Cmd+N indexing.
- [ ] The capture tab is **hidden** from the renderer's Tabs list (both the client
      that created it and a second Electron client on the same host).
- [ ] A message in the conversation **open + focused** in the usable Teams tab is
      captured and fires an OS notification (the bug case).
- [ ] Multi-client: a second Electron client does not spawn a duplicate capture tab
      when one is already live; if a duplicate is ever created, reconcile reaps the extra.
- [ ] Notification-click still opens/activates the **usable** Teams tab, not the capture tab.
- [ ] Web build is byte-unchanged (feature is Electron-only; Slack-web stays sweep-covered).
- [ ] Generic mechanism: the capture-tab behavior is driven by an adapter flag so
      Outlook/Slack can opt in later; only **Teams** is enabled now.

## Test plan

### Layer 1 — Pure logic (TDD)

- [x] Capture-tab planner (`core/capture-tab.js` `planCaptureTabs`) — create/reap from
      the target list: none-marked+usable → create; one+one → no-op; >1 capture → reap
      extras; no usable → reap the lone one; empty → nothing; per-adapter independence.
      `core/capture-tab.test.ts` (8 cases, green).

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] Boot Electron against the live host; confirm one capture tab appears on the
      remote browser (via `/json`, `window.name === "__cdpCaptureTab"`), hidden from the sidebar.
- [ ] Open a Teams chat in the usable tab, keep it focused; have someone send a
      message → OS notification fires (previously dropped).
- [ ] Close the capture tab manually → it is recreated within a reconcile cycle.
- [ ] Second Electron client on the same host → still exactly one capture tab; both clients notify.
- [ ] Click a Teams notification → the **usable** tab is activated, capture tab stays background.

### Layer 3 — Visual review

- [ ] Sidebar Tabs list does not show the capture tab (screenshot).

## Design notes

- **New behavior:** a per-adapter `captureTab: true` flag (Teams only, now) drives a
  keeper that maintains one hidden background capture tab, marked via `window.name`.
- **Marker:** `window.name = "__cdpCaptureTab"`, set through
  `Page.addScriptToEvaluateOnNewDocument` (re-applies on reload) + an immediate
  evaluate; detected cross-client by evaluating `window.name` over the existing
  side-channel socket and surfaced back to main so the renderer can hide it.
- **Never-activate / never-suppress invariant:** creation uses
  `Target.createTarget({ background: true })` (opens without foregrounding); the tab
  is excluded from activation/indexing paths and from the visible tab list.
- **New ADR needed?** yes — written: `docs/adr/0018-dedicated-notification-capture-tab.md`.

**As built:**
- `core/capture-tab.js` — pure `planCaptureTabs` + `CAPTURE_MARKER` ("__cdpCaptureTab").
- `core/notifications-sidechain.js` — Teams adapter gains `captureTab: true` + `captureUrl`;
  reads `window.name` on attach, exposes `isCaptureTab(id)`.
- `main.js` — the keeper: `createCaptureTab` (browser-WS `Target.createTarget({background:true})`
  + marker stamp), `reconcileCaptureTabs` (cooldown-gated, folded into the 5s notification
  reconcile), and `cdp:list-tabs` filters out capture tabs (hides from renderer + history).

## Out of scope

- Outlook and Slack-Electron capture tabs (flag exists; not enabled until each is
  probed the same way). Slack-web is already covered by the content sweep.
- Web build changes.
- Any change to mark-read or presence behavior on the usable tab.

## Definition of Done

- [ ] Layer 1 tests written and green
- [ ] Layer 2 smoke checklist completed with the live Remote Browser
- [ ] Layer 3 screenshot committed
- [ ] `pnpm check` clean, `pnpm typecheck` clean, `pnpm test` green
- [ ] `pnpm dev` boots cleanly and the capture tab works end-to-end
- [ ] CLAUDE.md updated for the modified modules
- [ ] ADR written
- [ ] No debug debris, no AI attribution
- [ ] Task closed: status → done, moved to `docs/tasks/done/`, t105 in commit

## Notes

Probe evidence (2026-07-13, live remote Teams at the tailnet host):

- Two Teams tabs coexisted; capture tab `visibilityState: hidden`, no dormant
  "open elsewhere" screen.
- Dual-poll t57–t59: `PRIMARY(visible/true) wraps=0` vs `TAB2(hidden/false) wraps=1`
  for the same Ethan-chat message while the primary tab had that chat open + compose
  focused → proves per-tab suppression + hidden-tab capture.
- Marker persistence: `window.name`/`sessionStorage` survived reload; URL query/hash stripped.
