# 103 — Sync pins and history across devices with New Tab suggestions

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** none

## Goal

Pins and browsing history become shared across the user's devices via the web
server, and the New Tab modal turns into an omnibox: it suggests from history
(matched on address **and** title) and offers "Switch to tab" for tabs already
open. The Electron app opts into the shared backend with a per-device toggle +
sync-server URL; when off it behaves as today (local pins, no remote history).

## Why now

The daily driver is the iPad PWA plus the Mac Electron app. Today a pin made on
one never appears on the other, and New Tab only knows about pins. This closes
both gaps and makes New Tab a real address bar. See ADR-0017.

## Acceptance criteria

- [~] A pin created/removed/reordered in Electron (sync on) appears on the PWA and vice-versa. — code complete; final two-device confirmation deferred to the preview-deploy test.
- [x] Turning sync ON in Electron adopts the server's pin set (server-wins). — `handleSyncEnabledChange` re-loads pins from the server.
- [x] Browsing pages records history on the server; it persists across restarts. — verified: `web-history.json` populated from the tab poll, page-only.
- [x] New Tab suggests history matched by both URL and page title, frecency-ranked.
- [x] A query matching an open tab (CDP or local) shows "Switch to tab" and activates it instead of opening a duplicate. — verified via /cdp (switched to the general Slack tab, no dup).
- [x] The pinned quick-launch row still shows when the query is empty.
- [x] Sync toggle + (Electron-only) server-URL field live in Settings; web is inherently synced (card hidden on web).
- [x] With sync off / URL unset / server unreachable, Electron falls back to local pins and doesn't crash (`syncOrLocal`).

## Test plan

### Layer 1 — Pure logic (TDD)

- [x] `core/history-store.js` `recordVisit` — dedup by URL, bump visitCount, update title/lastVisit, cap size
- [x] `core/history-store.js` `rankHistory` — frecency ordering (recency × frequency)
- [x] `core/history-store.js` `visitsFromTabs` — diffs a tab snapshot into new visits, ignores unchanged URLs
- [x] `src/lib/tab-suggest.ts` — matches history on url + title, diacritic-safe; open-tab matches marked as switch; ranking/limit

### Layer 2 — Manual smoke (CDP/IPC)

- [~] Electron sync on → pin appears on PWA (server file updated); sync off → local file only — server pin/history endpoints proven live; two-device Electron↔PWA confirmation in the preview test.
- [x] Electron unreachable sync URL → pins fall back to local, no crash (`syncOrLocal` try/catch → local store).
- [x] Browsing in web writes history; Electron main boots clean with the capture wired in `cdp:list-tabs`.

### Layer 3 — Visual review

- [x] Screenshots via Chrome MCP against the web build (omnibox + tab-item polish).
- [x] New Tab: empty (pins), typing (Open URL + switch rows) verified; no-match falls through to pins.
- [~] Settings sync card renders — Electron-only (`!caps.web`), hidden on web as designed; live Electron GUI render not screenshotted.

## Design notes

- **Contracts changed:** `CdpBridge` (`window.cdp`) — add `getHistory()` and `recordVisit(visit)`; `NewTabDialogProps` — add `history`, `openTabs`, `onSwitchTab`. New Electron settings `syncEnabled: boolean`, `syncServerUrl: string`.
- **New modules:** `core/history-store.js` (pure history read-model + tab-diff), `src/lib/tab-suggest.ts` (pure suggestion matcher). One Electron sync helper in `main.js` (effectful HTTP proxy).
- **New ADR needed?** yes — ADR-0017 (written).

```ts
type Visit = { url: string; title: string; ts: number; visitCount: number }
type Suggestion =
  | { kind: "switch"; tabKind: "cdp" | "local"; id: string; title: string; url: string }
  | { kind: "history"; title: string; url: string }
```

## Out of scope

- E2E/Authentik-aware Electron sync (plaintext tailnet only — ADR-0017).
- Real-time push of pin/history edits — sync is eventual (on launch/reconnect + omnibox open + the on-toggle re-load); no live SSE channel.
- SPA in-tab route history that never changes the `/json` URL.
- Syncing anything beyond pins + history (settings, notifications stay as-is).

## Definition of Done

- [x] Layer 1 tests written and green (25 new tests: history-store + tab-suggest)
- [~] Layer 2 smoke — web path proven against a live Remote Browser; Electron main boots clean; two-device sync confirmation in the preview test
- [x] Layer 3 screenshots captured (omnibox + tab-item polish)
- [x] `pnpm typecheck` clean
- [x] `pnpm test` (1049) + `pnpm test:e2e` (49) green
- [x] CLAUDE.md + src/lib/CLAUDE.md + CONTEXT.md updated for modified modules
- [x] ADR-0017 written
- [x] Task closed: status → done, moved to `docs/tasks/done/`, t103 in commit

## Notes

Grilled decisions (2026-07-09): Electron joins server; server-wins on enable;
history stored on shared backend; New Tab = history(url+title) + switch-to-tab +
keep pins; Electron link is plaintext tailnet URL (no auth/E2E); all three built
together.
