# ADR-0018: Dedicated notification capture tab

- **Status:** Accepted
- **Date:** 2026-07-13

## Context

The Notification Side-Channel (ADR-0003) captures Teams/Outlook notifications by
scraping each site's **own in-app toast DOM** (`notification-wrapper` for Teams).
This has a blind spot: chat apps **suppress the toast for the conversation a tab has
open + focused** — you're looking at it, so no banner is shown. The side-channel
therefore never sees a message that arrives in the actively-viewed conversation.

The failure is acute on the remote-browser model. Only one remote tab is foreground
at a time. When the operator screencasts the Teams tab and then walks away (backgrounds
the local CDP-Browser window), the remote Teams tab *still looks actively viewed* to
Teams — it is the foreground remote tab with a conversation open — so every message in
that chat is dropped. A second operator (an assistant on a second Electron client
against the same remote browser) misses the same messages, because remote-tab
visibility is a property of the one shared page, not of any viewer.

Slack does not have this problem on the web build: its **content sweep** (ADR-0011)
reads unread state over Slack's web API, independent of what any tab renders.
Teams/Outlook have no such authoritative side path.

We verified the suppression model empirically against the live remote Teams (Edge 150):

- Teams v2 **allows a second concurrent tab** — no single-instance "open elsewhere"
  parking; both tabs run their notification pipeline.
- Suppression is **client-side / per-tab**: at the same instant, the focused tab
  rendered **no** toast (suppressed) while a **hidden** second tab rendered the toast
  for the same message. So a background tab with no conversation focused sees every
  message. This rules out server-side suppression — the notification event *is*
  delivered; only the focused tab chooses not to render it.
- `window.name` survives a Teams reload; a URL query/hash marker does **not** (Teams
  normalizes back to `/v2/`).

## Decision

Keep one **dedicated capture tab** per capture-enabled adapter: a remote tab that is
**always background** (never activated, no conversation focused), so the app fires its
toast for **every** message — including the one open in the usable tab — and the
existing side-channel captures it. The tab the operator actually uses is left
untouched: normal presence, normal mark-read.

- **Marker.** The capture tab carries `window.name = "__cdpCaptureTab"`
  (`core/capture-tab.js` `CAPTURE_MARKER`), set at creation via
  `Page.addScriptToEvaluateOnNewDocument` + an immediate evaluate. It is durable
  (survives reload) and readable by **any** client over its side-channel socket, so a
  second Electron client recognizes the same shared capture tab without any
  cross-client coordination store.

- **Keeper (Electron `main.js`).** A pure planner
  (`core/capture-tab.js` `planCaptureTabs`) decides create/reap from the current target
  list: a capture-enabled adapter with a usable (non-marked) tab and no capture tab →
  open one (background, cooldown-gated); more than one capture tab → reap the extras
  (a multi-client race self-heals); no usable tab left → reap the lone capture tab (never
  force-open the app for someone who does not use it). Creation uses
  `Target.createTarget({ background: true })` over the browser CDP socket so it never
  steals the remote foreground (`/json/new` would).

- **Invisibility.** The capture tab is filtered out of the `cdp:list-tabs` result, so
  the renderer never sees it — it cannot appear in the Tabs list, be activated by
  tab-switch / Cmd+N / notification-click, or pollute browsing history. The
  side-channel reads the raw `/json`, so it still attaches and captures.

- **Scope.** Driven by a per-adapter `captureTab` flag; enabled for **Teams** only
  (the one verified). Outlook and Slack-Electron can opt in after the same probe.
  Electron-only — the web build's Slack path is already sweep-covered, and web is not
  a notification surface for the operator's own account.

## Consequences

- Messages in the actively-viewed Teams conversation are captured and pushed, on
  every Electron client against the shared remote browser — the last correctness gap
  in Teams capture closes.
- The usable Teams tab keeps correct presence and mark-read (no visibility spoofing on
  the tab the operator uses) — the reason this beats forcing the usable tab hidden.
- Cost: one extra background Teams instance per remote browser (some remote RAM/CPU);
  the existing side-channel CDP attachment keeps it from being tab-frozen/discarded, the
  same as the Slack keeper.
- The capture tab never marks its messages read (it is never focused). That matches the
  app's existing "unread as a to-do trail" stance (the Slack reader deliberately skips
  `conversations.mark`, t077); the operator reads in the in-app inbox, not by clearing a
  remote badge.
- Extends ADR-0003 (side-channel) and mirrors the ADR-0011 Slack keeper, but this is a
  **capture-only** tab whose entire purpose is to stay unfocused — a distinct role from
  the Slack cred-lifeline parked tab.
