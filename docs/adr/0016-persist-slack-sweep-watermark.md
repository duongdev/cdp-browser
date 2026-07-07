# 0016 — Persist the Slack sweep watermark across restarts

**Date:** 2026-07-07
**Status:** Accepted
**Deciders:** t099 (C2)

## Context

The Slack Content Sweep (ADR-0011) is the authoritative delivery path for Slack notifications on the web build. Its per-workspace read state — the `watermark` (`teamId → { channelId: lastSeenTs }`) and the `seeded` set (teams whose baseline is established) — lived only in a module-level object in `web/server.mjs`.

On a fresh process the first sweep for a team takes the **seed** branch: it sets the watermark from the workspace's current `latest`/now and emits nothing (so a cold start doesn't spam the backlog as "new"). That seed branch is correct for a genuinely-new workspace, but because the state was memory-only it also ran on **every restart** — so every deploy, crash, or container recycle re-seeded from "now" and silently dropped any message that arrived during the downtime window. For a push-notification daily driver (the web PWA, priority surface) that is periodic, invisible message loss — the exact failure the sweep exists to prevent. A code comment even claimed a cold start was "a re-fetch (not re-notify)", which was false.

## Decision

**Persist `{ watermark, seeded }` to disk and resume from it on boot.**

- A new non-secret file `slack-sweep-state.json` (channel ids + message timestamps only — no creds) holds the serialized state, next to the other server JSON files. Env-overridable via `SLACK_SWEEP_STATE_PATH`.
- On boot the server loads it: a team with a persisted watermark is already `seeded`, so the next sweep takes the normal **fetch-since-watermark** branch and backfills the downtime gap; the store's stable `slack:{groupId}:{channel}:{ts}` id-dedup makes re-fetching already-ingested messages a no-op, so only genuinely-missed messages notify. Only a team with **no** persisted state seeds from `latest`.
- Writes go through a **debounced (~2s trailing)** persister that coalesces a busy multi-workspace sweep into one write, using the shared **atomic** write-temp-then-rename helper (`core/atomic-write.js`) so a crash mid-write can't corrupt the file.
- A **SIGTERM/SIGINT** handler flushes synchronously before exit, so a graceful redeploy never loses the last ~2s of read progress. (This also closes the "no server shutdown hook" gap the review found.)

The pure serialize/deserialize + the DI'd debounced persister live in `core/slack-sweep-state.js` (unit-tested); `web/server.mjs` wires the IO and hooks `scheduleFlush()` into the sweep's `setWatermark`/`markSeeded`.

## Consequences

### Positive

- A restart/redeploy no longer opens a silent notification blind spot: the sweep resumes from the watermark and backfills the gap.
- The seed-once-per-team semantics are now actually true (seed on first-ever sight, resume thereafter), matching what ADR-0011 always claimed.
- The atomic write + shutdown flush harden persistence generally (the helper is reused by C3 for the other JSON files).

### Negative

- After a **long** outage (hours/days) the resume fetches a large history window, which can produce a burst of older notifications on recovery. Accepted: delivering delayed messages is the goal, and the notification store cap bounds the burst. A short redeploy (the common case) backfills only seconds of gap.
- One more small file on disk. It is non-secret (no tokens/cookies), so it carries no new leak surface beyond the message metadata already in `web-notifications.json`.

## Alternatives

- **Seed from `last_read` instead of `latest`** to backfill still-unread pre-watch messages into the inbox. Rejected for this task: that is a different feature (an "unread catch-up view"), changes first-ever-boot behavior, and risks a large cold-start burst. Resume-from-watermark solves the restart-loss bug without it.
- **Fold the state into `slack-workspaces.json`.** Rejected: that file is a low-churn registry written on workspace discovery; the watermark advances on every sweep, so a separate file with its own debounced write cadence keeps the two write patterns from interfering.
- **Leave it memory-only and accept the loss.** Rejected: it is a P1 silent-notification-loss bug on the priority surface.

## Links

- **ADR-0011:** Slack Content Sweep guaranteed delivery — this makes its cold-start claim true.
- **Task t099 (C2):** capture continuity.
- **Modules:** `core/slack-sweep-state.js`, `core/atomic-write.js`.
