# 164 — standalone electron chat app + install tooling

- **Status:** done
- **Mode:** HITL (native window + notifications need manual verify)
- **Estimate:** 0.5d
- **Depends on:** none (chat web build already ships)
- **Blocks:** none

## Goal

A separate desktop app for the Teams chat surface, distinct from the CDP Browser.
`chat-main.js` is a thin Electron shell that loads a running web server's `/chat`
route in its own window. `scripts/install-local.sh` now builds and installs both
apps (CDP Browser + Teams Chat) side-by-side.

## Why now

PSN-91: the chat was web/PWA only. A native window gives dock presence, its own
app icon, and OS notifications while open — the daily-driver ask.

## Acceptance criteria

- [x] `chat-main.js` loads `${server}/chat/`; server URL resolves env → stored → localhost default.
- [x] External links open in the OS browser; same-origin navigations stay in the shell.
- [x] Window bounds persist across launches (`userData/chat-config.json`).
- [x] `pnpm dist:chat` / `dist:chat:dir` build a separate "Teams Chat" bundle (own appId, `release-chat/`).
- [x] `scripts/install-local.sh` builds + installs both apps.
- [x] Foreground OS notification fires for a new incoming message when the window is unfocused; click opens the conversation.

## Test plan

### Layer 1 — Pure logic (TDD)

- [x] `core/chat-shell.js` — `resolveServerUrl` precedence + trailing-slash trim; `isExternalUrl` origin compare + malformed→external.
- [x] `chat/src/lib/notify-new.ts` — `newlyArrived` first-sight suppression, incoming-advance detection, own-message + unchanged-ts skip.

### Layer 2 — Manual smoke

- [ ] Launch Teams Chat.app against a live web server; conversations load, links open in browser, window size remembered.
- [ ] Background the window, receive a message → macOS notification; click opens the thread.

### Layer 3 — Visual review

- n/a — the shell hosts the existing chat renderer unchanged; no new UI.

## Design notes

- **New modules:** `chat-main.js` (Electron entry), `core/chat-shell.js` (pure URL helpers), `chat/src/lib/notify-new.ts` (poll-diff), `electron-builder.chat.json` (second build config).
- **New ADR needed?** no — thin shell over the existing ADR-0019 web backend; no new architecture.

## Out of scope

- Self-contained Electron chat backend (own CDP keeper + Teams creds) — deferred; the shell needs a running web server.
- Background Web Push in Electron (no browser push service) — foreground Notification API only.
- A distinct chat app icon (reuses the browser icon).

## Notes

Server URL default is `http://localhost:7800`; set `CHAT_SERVER_URL` or edit
`userData/chat-config.json` for a remote/tailnet server before release use.
