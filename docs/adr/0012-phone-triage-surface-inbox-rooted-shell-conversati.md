# ADR-0012: Phone triage surface: inbox-rooted shell + conversation reader

- **Status:** Accepted (all phases shipped t076–t081)
- **Date:** 2026-06-11

## Context

The PWA is iPad-targeted (ADR-0009: Magic Keyboard primary, finger secondary). On a phone it is nearly unusable, and the phone has a job the iPad doesn't cover: enterprise Slack exists **only** on the remote desktop, so when the user is AFK the PWA is the only mobile window into it. The phone's job is *don't miss a notification* — triage, not driving.

The blunt blocker: Slack web has no responsive layout. With Adaptive Viewport on a ~390px canvas the remote page is resized to phone width and Slack breaks — and the override mutates the Remote Browser globally (ADR-0002), squeezing what the desktop session sees. Mobile-UA emulation is also out: Slack web serves an app-store interstitial to mobile UAs.

Meanwhile the Slack Content Sweep (ADR-0011) already holds authoritative content server-side: creds, `conversations.history`, rendered titles/bodies. The best phone rendering of a Slack message doesn't need the screencast at all.

## Decision

Below a viewport-width breakpoint (reactive `matchMedia`, not pointer-coarseness, not a `caps` flag) the renderer runs a distinct **Phone Shell**:

1. **Inbox is the root view** — the full-screen notification list grouped by conversation (the bell popover's `groupByConversation` read model, promoted to route level). The screencast canvas is a destination, not home. The wide layout is untouched above the breakpoint.
2. **Tap opens the Conversation Reader** — a phone-native detail view rendered from captured content, never from Screencast Frames. Reader availability is a per-adapter capability flag: Slack renders a real message view from sweep data; adapters without a content backend (Teams, Outlook) show a stub detail from the captured toast text. "Open in browser" is the explicit screencast escape hatch.
3. **Slack reader gets a text-only composer in v1** — `chat.postMessage` through the same sweep creds. Reply target is context-dependent (DM → plain message, channel mention → its thread, thread notification → that thread) behind one pure, swappable selector. Send failure is synchronous and honest: draft stays in the box with a retry; no offline outbox on extracted enterprise creds.
4. **Reading marks locally only** — the reader never writes `conversations.mark`; Slack's own unread state (and the desktop badge) survives as a to-do trail. A swappable seam if this changes.
5. **The phone never applies Adaptive Viewport.** The screencast view renders the remote page at its native size, fit-to-screen, with **local pinch-zoom + pan** — a pure client-side transform composed into the existing Viewport Transform chain. Zero remote-side mutation; desktop Slack stays intact. This supersedes ADR-0009's pinch-zoom deferral with the local variant (CDP `Input.dispatchTouchEvent` fidelity stays deferred).
6. **Push is the delivery spine**: the push payload carries the conversation key so a notification tap deep-routes into the reader, including cold start; `navigator.setAppBadge` mirrors the Inbox unread count on the home-screen icon.
7. **v1 scope**: plus a flat tab/pin switcher and Settings; cut command palette, shortcut overlay, find bar, drag interactions, screencast typing (ADR-0009's OSK bridge stays deferred — typing happens in the reader's real `<textarea>`). Manifest `orientation` becomes `"any"`.

## Consequences

**Easier:**
- The Slack-not-responsive problem disappears instead of being solved: the reader renders content natively, and the escape-hatch screencast keeps the page desktop-width.
- The phone leans on infrastructure that already exists headless (sweep, web push, read-sync) — the core loop (push → glance → tap → read → reply) needs no new capture machinery.
- Local pinch-zoom is far cheaper than remote touch fidelity and benefits the iPad too.

**Harder:**
- A second shell to keep alive: phone routes, reader, switcher — more surface per feature, and feature work must ask "what does this look like on phone?"
- First Slack **writes** through extracted creds (`chat.postMessage`): stale-cred and 429 handling become user-facing on a phone, and reply mis-targeting is a real failure class (mitigated by the pure selector + tests).
- Reader-on-demand `conversations.history` adds a new load pattern on the sweep's rate-limit budget.

## Alternatives

- **Responsive squeeze of the existing shell** (canvas stays root, sidebar becomes a drawer) — rejected: optimizes the phone for driving, which Q1 of the design session established the phone is not for.
- **Adaptive Viewport with a min-width clamp** — rejected: still mutates the Remote Browser globally, still soft/small text, per-site breakage guesswork lives on.
- **Mobile-UA emulation** (`setDeviceMetricsOverride mobile:true` + UA) — rejected: Slack web blocks mobile UAs with an app-install interstitial; also a global mutation.
- **Offline reply outbox** — rejected: a queued message posting hours later out of context is worse than an honest failure.
- **Screencast-first phone with full touch fidelity** (`Input.dispatchTouchEvent`, OSK bridge) — rejected for this surface: maximal cost for the worst possible rendering of Slack on a 6" screen.
