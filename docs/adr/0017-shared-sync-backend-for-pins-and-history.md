# ADR-0017: Shared sync backend for pins and history

- **Status:** Accepted
- **Date:** 2026-07-09

## Context

Pins persist through the same `core/settings-store.js` API in both builds, but to
**different files**: the web server writes `web-settings.json`, and every web/PWA
device that talks to one server already shares those pins. The Electron app writes
`userData/settings.json` on the local Mac, so its pins never leave the machine.
Result: a pin made on the Mac never shows on the iPad PWA and vice-versa.

Separately, the New Tab modal only suggests pins. There is no browsing history to
suggest from — and CDP/Edge exposes no history API (there is no `History` domain),
so history has to be *recorded* as the user browses rather than read from the
remote browser.

We want: (1) one pin set shared across the user's devices, opt-in per device;
(2) a browsing-history store that follows the user across devices; (3) New Tab
suggestions from that history (matched on address **and** title) plus a
"Switch to tab" action for tabs already open.

## Decision

The **web server is the source of truth** for synced pins and history. Both are
served over its plain HTTP API.

- **Pins.** Web is already server-backed (`/api/pins*`) and therefore already
  synced across web devices. Electron gains two settings — `syncEnabled` (bool)
  and `syncServerUrl` (string). When both are set, Electron's pin IPC handlers
  proxy CRUD to `${syncServerUrl}/api/pins*` over **plaintext HTTP** instead of
  the local settings file; when off, it keeps today's local behavior. First
  enable is **server-wins**: the device adopts the server's pin set.

- **History.** A new pure `core/history-store.js` owns the read-model
  (dedup-by-url, frecency rank, cap) and the tab-snapshot diff that turns the
  existing `/json` tab poll into visit records `{ url, title, ts, visitCount }` —
  no extra CDP subscription. The server persists `history.json` and serves
  `/api/history`. Electron records to the same server when sync is on, else to a
  local file.

- **Transport for Electron.** Plaintext tailnet URL, no auth and no E2E — the
  sync endpoint is expected to be a reachable tailnet address (like the previews),
  not the Authentik/E2E-fronted prod portal. Keeping Electron plaintext avoids
  porting the crypto-envelope handshake into the main process.

- **Propagation.** Pins update in **near-real-time**: every renderer re-fetches the
  pin store on the same ~3s cadence as the tab-list poll, re-resolves each pin's
  link against its live tabs, and applies only when the set actually changed (a
  short grace window after a local edit prevents a stale read reverting an in-flight
  write; an unchanged fetch never churns the list, so a drag in progress is safe).
  History is fetched fresh each time the New Tab omnibox opens, so it is current on
  every open. No live SSE push is needed — the poll is simple and uniform across
  both builds.

## Consequences

- Easier: one pin set and one history across the Mac app and the iPad PWA; New
  Tab becomes a real omnibox (history + open-tab switch), matching the daily-
  driver bar.
- Harder: Electron gains an **optional dependency on the web server** — a second
  network target beyond the CDP host. It is opt-in and degrades to local when the
  URL is unset or unreachable.
- Plaintext-only Electron sync will **not** work against the Authentik/E2E prod
  portal; a tailnet endpoint is required. Revisit if that becomes limiting.
- History is captured from the tab poll, so it records the pages that appear in
  the tab list — not in-tab SPA route changes that never change the `/json` URL.
  Acceptable for suggestion quality; revisit if SPA-heavy history matters.

## Alternatives

- **Electron talks CDP only, no server.** Rejected: there is no shared store, so
  no cross-device sync — the whole point.
- **A separate dedicated sync service.** Rejected: the web server already holds
  the authoritative pins and is already deployed; a new service is more moving
  parts for no gain.
- **Capture history via `Page.frameNavigated` side-channels on every tab.**
  Rejected for v1: more CDP sockets and lifecycle to manage; the tab-poll diff is
  simpler and covers the real use (pages you actually land on). Can be added later
  if SPA route history is wanted.
- **E2E/Authentik-aware Electron sync.** Deferred: needs the crypto handshake in
  main; plaintext tailnet is enough for now.
