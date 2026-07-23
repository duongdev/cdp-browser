# t150 — Chat persisted routing (URL is the state)

**Goal.** A refresh or PWA relaunch of `/chat` lands back in the conversation you were in; deep-links and browser back/forward work. The URL is the source of truth.

**Approach.**
- Path scheme: `/chat/c/{convId}` (Teams thread id, URL-encoded); the list is `/chat/`.
- Pure URL logic in `chat/src/lib/chat-route.ts`: `parsePath(pathname)` → `{convId} | null`, `pathFor(convId | null)` → string. TDD'd in `chat-route.test.ts`.
- `chat-app.tsx` wire-up (thin): boot reads `location.pathname` → opens that conversation; opening a conversation `pushState`s its path; back-to-list pushes `/chat/`; a `popstate` listener replays the path (browser/PWA back-swipe pops thread → list on phone). popstate-driven opens don't re-push.
- ThreadView fetches by id alone, so an unknown/gone id opens optimistically and shows its own error state — never a blank or crash.
- No router lib. Keep-alive panes unaffected — routing only picks `activeId`.
- `serveChat` SPA fallback + the `/chat/` SW navigation fallback already serve `index.html` for any `/chat/*` path, so deep-links work with no server or SW change.

**Acceptance.**
- [x] Refresh mid-conversation reopens that conversation (wide + phone).
- [x] Browser/PWA back pops thread → list on the phone layout.
- [x] Deep-link `/chat/c/{id}` opens directly; bad id falls to ThreadView's error state, not a blank.
- [x] Pure URL logic extracted + TDD'd; wire-up stays thin.
- [x] `pnpm chat:build` + `pnpm typecheck` + `pnpm test` clean.
