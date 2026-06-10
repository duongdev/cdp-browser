# 069 — extract slack creds via side-channel

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** 067
- **Blocks:** 070, 071

## Goal

Teach the Slack notification side-channel to extract the workspace's web-API credentials from a live tab: the `xoxc-…` token (from the page's `localConfig`/boot data via `Runtime.evaluate`) and the `d` session cookie (`Network.getCookies`). Creds refresh whenever a workspace tab is live. A 401 `invalid_auth` from the API client (067) marks that workspace's creds stale. After this task the server holds fresh-enough creds per workspace to drive the sweep, with no manual setup.

## Why now

The sweep can't run without creds. Both the registry/parked-tab keeper (070) and the server wiring (071) consume the extracted creds + the stale signal. ADR-0011 phase 4.

## Acceptance criteria

- [ ] On side-channel attach to a Slack target, the server extracts `{ token, cookie }` and stamps the workspace's `teamId`.
- [ ] Extraction is best-effort and non-fatal: a parse miss leaves prior creds intact and logs, never throws.
- [ ] A 401 from the API client marks the workspace creds stale (a flag the health surface and parked-tab keeper read).
- [ ] Creds are never logged in full (redact token/cookie in any diagnostic output).

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] token/cookie parse helper — covers present, absent, malformed.
- [ ] stale-state transition — fresh → stale on 401, stale → fresh on successful extraction.

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] Open a Slack workspace tab; confirm the server extracts a `xoxc` token + `d` cookie and a subsequent `clientCounts` returns `ok`.
- [ ] Revoke/expire (sign out remotely); confirm the 401 marks creds stale.

### Layer 3 — Visual review

n/a — surfaced in 074.

## Design notes

- **Contracts changed:** `notifications-sidechain.js` Slack adapter gains a cred-extraction hook; the side-channel emits `{ teamId, token, cookie }` to an injected sink.
- **New modules:** a small pure parse helper (token/cookie extraction) — testable.
- **New ADR needed?** no — ADR-0011 (security consequence already recorded).

## Out of scope

- Persisting creds / registry (070).
- Polling Slack (071).
- The keep-alive tab loop (070).

## Definition of Done

- [ ] Layer 1 tests green
- [ ] Layer 2 smoke completed with a live Slack tab
- [ ] `pnpm check` / `pnpm typecheck` / `pnpm test` green
- [ ] `node --check web/server.mjs` clean
- [ ] CLAUDE.md updated for the changed side-channel contract
- [ ] Creds redacted in all logs
- [ ] No debris, no AI attribution
- [ ] Task closed: status → done, moved to `done/`, t069 in commit

## Notes

Creds at rest is the headline security cost — same trust boundary as settings/notifications files (ADR-0011).

---

_When task status flips to `done`, move this file to `done/`._
