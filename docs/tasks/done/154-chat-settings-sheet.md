# t154 — Chat settings sheet (theme + density)

Status: done · Workstream F (PSN-90) · web only

## Goal

A settings sheet for the `/chat` Teams app. v1 scope (grilled #4) is **fixed**: theme
(light / dark / system) + density (comfortable / compact) only, plus relocating the existing
push toggle into the sheet. No send-key, no poll cadence, no read receipts.

## What shipped

- **`chat/src/lib/chat-settings.ts`** (pure, TDD) — owns the defaults, parse-guards, the ui-state
  key remap (`chatTheme_<deviceId>` / `chatDensity_<deviceId>`), and `resolveDark(theme, osDark)`
  (theme resolution). Mirrors the `/` build's `device-prefs.ts` shape.
- **`chat/src/lib/use-chat-settings.ts`** — loads once from `/api/ui-state`, optimistic local state,
  writes changes back device-keyed. Applies theme (`.dark` class) + density (`data-density` attr)
  to the document root on every change. Reuses the `/` build's `cdp_device_id` localStorage
  identity (one id per device across both surfaces — no second scheme).
- **`chat/src/components/settings-sheet.tsx`** — shadcn Sheet: 3-way theme segmented, 2-way density
  segmented (mirrors the `/` build's picker pattern), and the relocated `NotifyToggle` push row.
- Wired into `chat-app.tsx`: a header gear affordance + a ⌘K "Open settings" action (t152 registry).
- **`chat/src/index.css`** — `[data-density="compact"]` tightens `.conv-row`, `.thread-messages`,
  and `.teams-message-body` (padding + font-size). Marker classes added to `conversation-row.tsx`
  and `thread-view.tsx`.
- **`core/settings-store.js`** — added `chatTheme_` / `chatDensity_` to `DEVICE_KEY_PREFIXES` so the
  device-keyed slots round-trip through the store (survive an iPad-PWA localStorage wipe).

Push toggle removed from its old header placement (now inside the sheet).

## Persistence

Server ui-state, device-keyed — never localStorage (wipes on the iPad PWA). Keys:
`chatTheme_<deviceId>`, `chatDensity_<deviceId>`. Reached via the same same-origin `/api/ui-state`
REST surface the `/` build uses.

## Verification

- `pnpm test` (1432 pass, incl. `chat-settings.test.ts`), `pnpm typecheck`, `pnpm chat:build` clean.
- Live (server :7911, headless Chrome): (a) sheet opens from the gear; (b) Dark forced from the
  sheet turns the whole app dark; (c) Compact visibly tightens list rows (10px→4.8px) + bubbles;
  (d) dark+compact survive a full page reload (restored from server ui-state, not localStorage).
  Screenshots: `/tmp/psn90-f-{a-sheet,b-dark,c-compact,d-persist}.png`.
