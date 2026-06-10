# 067 — slack web-api client

- **Status:** done
- **Mode:** AFK
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** 068, 069, 071

## Goal

Add `core/slack-api.js` — the effectful, cred-injected Slack web-API client the content sweep (ADR-0011) calls. It authenticates with an extracted `xoxc-…` token + `d` cookie, is rate-limit aware, and exposes the three reads the sweep needs: `clientCounts` (per-channel unread/mention/thread counts + `last_read`), `conversationsHistory` (message content since a watermark), and `usersInfo` (name resolution). After this task the server can read a workspace's authoritative unread state given valid creds.

## Why now

The foundation for the whole sweep. Pure reducer (068) and server wiring (071) both depend on a real client to call. ADR-0011 phase 2.

## Acceptance criteria

- [ ] `core/slack-api.js` exports a factory taking `{ token, cookie, fetch?, now? }` (DI for tests) and returns `{ clientCounts, conversationsHistory, usersInfo }`.
- [ ] Auth wired correctly: `xoxc` token in the POST body/header, `d` cookie in the Cookie header.
- [ ] Rate-limit aware: respects HTTP 429 `Retry-After`; serializes/space calls to stay within Slack Tier limits.
- [ ] A 401 `invalid_auth` is surfaced as a typed result (not a throw), so the caller can mark creds stale.
- [ ] Added to `package.json` `build.files` allowlist (any `core/**/*.js` already covered — confirm).

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] `clientCounts` request shape + response parse — covers DM/channel/thread count extraction and `last_read`.
- [ ] `conversationsHistory` pagination since a cursor/ts — covers gap coverage.
- [ ] 401 → typed `invalid_auth` result, not a throw.
- [ ] 429 → honors `Retry-After`.

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] Against a fake Slack host (mirror `test/e2e` fake-CDP pattern) the three methods return parsed shapes.

### Layer 3 — Visual review

n/a — no renderer UI.

## Design notes

- **Contracts changed:** none yet (new module).
- **New modules:** `core/slack-api.js` — the only place that talks Slack's web API; cred-injected so it holds no creds itself.
- **New ADR needed?** no — ADR-0011 covers it.

```ts
// shape, not file path
createSlackApi({ token, cookie, fetch?, now? }) => {
  clientCounts(): Promise<{ channels, ims, threads, ok } | { error: 'invalid_auth' }>
  conversationsHistory(channelId, { oldest }): Promise<{ messages } | { error }>
  usersInfo(userId): Promise<{ user } | { error }>
}
```

## Out of scope

- Extracting the creds (069) — this task receives them.
- The watermark/parity logic (068) — this task only fetches.
- Any store writes or entry synthesis (071).

## Definition of Done

- [ ] Layer 1 tests green
- [ ] Layer 2 fake-host smoke green
- [ ] `pnpm check` / `pnpm typecheck` / `pnpm test` green
- [ ] `node --check web/server.mjs` still clean (if imported)
- [ ] CLAUDE.md (core list) updated
- [ ] No debris, no AI attribution
- [ ] Task closed: status → done, moved to `done/`, t067 in commit

## Notes

TOS grey area — uses Slack's internal web API like the official client. Recorded in ADR-0011 consequences.

---

_When task status flips to `done`, move this file to `done/`._
