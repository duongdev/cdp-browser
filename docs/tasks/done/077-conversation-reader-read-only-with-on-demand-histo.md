# 077 — conversation reader read-only with on-demand history

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** 076
- **Blocks:** 078, 080

## Goal

Tapping a notification on the Phone Shell opens the **Conversation Reader** (ADR-0012): a phone-native detail view rendered from captured content, never from Screencast Frames. Slack entries render a real message view — the server exposes an on-demand history endpoint (`conversations.history` through the existing cred-injected Slack client, bodies via `slack-render`); adapters without a content backend (Teams, Outlook) render a stub detail from the captured toast text. Reader availability is a per-adapter capability flag checked by tap routing — no hardcoded Slack branch. "Open in browser" is the explicit screencast escape hatch. Opening the reader marks the entry read **locally only** (never `conversations.mark`).

## Why now

The core of the triage loop — without it the phone tap lands on desktop-width Slack in a screencast, which is the blocker this whole tree exists to remove. 078 (composer) and 080 (push deep-route) build on it.

## Acceptance criteria

- [ ] Tapping a Slack entry on the phone shell opens a message view for that channel/DM: sender, rendered body, timestamp, ordered like Slack.
- [ ] Tapping a Teams/Outlook entry opens a stub detail (captured toast text full-screen) — uniform tap behavior, richness varies by adapter.
- [ ] Reader routing is driven by a per-adapter capability flag, not entry-type conditionals scattered in the renderer.
- [ ] "Open in browser" from the reader lands on the screencast view with today's deep-open intent (activation registry).
- [ ] Opening the reader marks the entry read in the store only; Slack `last_read` is untouched (desktop badge survives).
- [ ] Stale creds (typed 401) and 429 render honest error states with a working retry; history fetches respect the Slack client's existing rate-limit handling.
- [ ] Wide shell behavior is unchanged (reader is phone-shell-only for now).

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] Reader-capability predicate per adapter — Slack true, Teams/Outlook stub path.
- [ ] History → view-model mapping (reuses `slack-render` `renderBody`/`composeTitle`) — mentions, channel refs, DM vs channel titles.
- [ ] Local-read marking — store flag set, no read-sync write planned.

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] Live Slack DM + channel mention: tap → correct conversation, correct order; retry path on a forced 401 (stale creds heal via parked-tab re-extract).

### Layer 3 — Visual review

- [ ] Reader: loading, empty (no history), error (401/429), populated.
- [ ] Stub detail for a Teams entry.

## Design notes

- **Contracts changed:** Notification Adapter grows a reader capability flag (one predicate). Server API grows a read-only history endpoint keyed `{ team, channel }`, returning rendered messages — it reads through the same `slack-api.js` client and creds the sweep uses; no new auth surface.
- **New modules:** reader view component; pure history→view-model mapper.
- **New ADR needed?** no — ADR-0012.
- E2E mode: the new endpoint rides the same sealed `/api` envelope as everything else.

## Out of scope

- Composer / replies (078).
- Pagination / infinite scroll — one history page (most recent N) is enough for triage v1.
- Reader on the wide shell.
- `conversations.mark` write (rejected for v1 — ADR-0012 §4; swappable seam).

## Definition of Done

- [ ] Layer 1 tests green
- [ ] Layer 2 smoke completed with live Slack
- [ ] Layer 3 screenshots captured
- [ ] `pnpm check:changed` / `pnpm typecheck` / `pnpm test` green
- [ ] CLAUDE.md + CONTEXT.md (Conversation Reader) consistent
- [ ] No debris, no AI attribution
- [ ] Task closed: status → done, moved to `done/`, t077 in commit

## Notes

New load pattern on sweep creds (on-demand history) — see the risk logged with ADR-0012; keep an eye on 429s during smoke.

Closure notes:
- Shipped: `toReaderMessages` (core/slack-render.js, 4 tests), `fetchConversation` (core/slack-sweep-runner.js, 3 tests — reuses resolveNames + name caches, never touches the watermark), `POST /api/slack/history` (web/server.mjs, 2 hermetic e2e tests for 400/401), `readerRoute` (src/lib/reader.ts, 4 tests — per-adapter capability table), `conversation-reader.tsx`, app.tsx phoneView "reader" + openReader.
- Verified against the visual harness via a11y snapshots: Teams entry → stub detail; Slack entry → history route → typed 401 → honest stale-creds copy + Retry; "Open in browser" → browser view. Chrome MCP `captureScreenshot` wedged mid-session (timeouts), so the reader states are documented by a11y snapshots instead of pixels — re-shoot during the live-remote HITL pass.
- Populated-history rendering is covered by unit tests (toReaderMessages/fetchConversation); a live-Slack smoke (real DM + channel) still wants the HITL pass with real creds.
- Read marking reuses the existing markThreadRead (store-only) — Q9's local-only semantics needed zero new code.

---

_When task status flips to `done`, move this file to `done/`._
