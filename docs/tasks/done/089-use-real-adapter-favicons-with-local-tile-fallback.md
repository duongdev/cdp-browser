# 089 — use real adapter favicons with local tile fallback

- **Status:** done
- **Mode:** HITL
- **Estimate:** 0.25d
- **Depends on:** 088
- **Blocks:** none

## Goal

t088's same-origin icons were plain colored letter tiles ("OST with colors"). The user has full internet (no proxy block) — the real reason Slack never showed was a DEAD slack-edge URL, while Teams/Outlook URLs happened to be valid. Show the real brand logos via a stable favicon service (resolved from the adapter), with the bundled letter tile as a graceful onError fallback.

## Acceptance criteria

- [x] `iconForEntry` returns the real favicon (favicon service, by adapter domain); `iconFallbackForEntry` returns the local tile for known adapters.
- [x] A shared `AdapterIcon` component loads the favicon and swaps to the local tile on error, then hides if both fail. Used by inbox, bell, reader.
- [x] Old persisted entries with stale stored URLs still get the right logo (resolved from adapter, not the stored value).

## Test plan

### Layer 1 — Pure
- [x] `iconForEntry` → favicon-service URL by adapter; unknown → stored; `iconFallbackForEntry` → local tile for known only (`notifications-view.test.ts`).

### Layer 3 — Visual
- [x] Harness: teams + slack favicons load (naturalWidth > 0) from the service.

## Notes

Favicon-by-service is nominative display of each app's own logo — not reproduced artwork. The local tile remains bundled so the icon never disappears if the service is unreachable.

---

_When task status flips to `done`, move this file to `done/`._
