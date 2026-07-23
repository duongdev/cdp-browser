# t157 — Chat bug hunt + world-class polish sweep (Workstream D)

Status: done
Depends on: t149–t156 (the full `/chat` UI revamp)
Scope: `/chat` (Teams chat app) only. The `/` browser build is byte-unchanged (no `src/**` edits).

The final review-then-fix integration sweep over everything t149–t156 shipped. Audited live
against the real Teams host (dev server :7911, worktree code, headless CDP :9333) across light +
dark and comfortable + compact, wide (1440px) and phone (390px). Each confirmed bug fixed at its
root cause in the shared pure module; everything else confirmed solid or deferred honestly.

## Found → fixed / deferred

| # | Surface | Finding | Verdict | Fix / reason |
|---|---|---|---|---|
| 1 | Thread (dark) | **Carry-over: "white cards" in a dark thread** (Glory & Haiyang). | **NOT A BUG** | Root-caused live: the white boxes are **AMS-proxied `<img>`** (course-notice screenshots with a white background baked into the pixels), NOT HTML with a surviving inline `style`/`bgcolor`. DOM probe confirmed **zero** inline styles survive the sanitizer (`nostyled:29`), and actual quoted-reply `<blockquote>` cards render correctly in dark (dark bubble, light text, `currentColor` border). The t151 sanitizer fix is working; there is no CSS/sanitizer gap. Dimming user image content would hide it — left as-is. |
| 2 | List keyboard nav | **j/k walks the raw newest-first list, ignoring folder grouping + collapsed folders.** With a folder collapsed, j/k lands the focus ring on **hidden rows** — the ring vanishes intermittently and Enter would open an off-screen conversation. | **FIXED** | Added pure `navigableConversations(conversations, collapsed)` in `conversation-view.ts` — reuses the render's own `groupByFolder`, so it can't drift, and drops collapsed folders' rows. `chat-app.tsx` walks it for `moveListFocus` instead of the raw list. Live-verified: with WORK collapsed, j now walks only visible rows in visual order, every focused row `visible:true` (was `NONE, visible, NONE, …` before). Also fixes the order mismatch (j/k now follows on-screen order). TDD test added. |
| 3 | Console | **`apple-mobile-web-app-capable` is deprecated** — the warning fires on every chat load (spam). | **FIXED** | Added the modern `<meta name="mobile-web-app-capable" content="yes">` alongside the apple one in `chat/index.html` (kept the apple meta — iOS still reads it). Chat-only; the `/` build's identical meta left untouched (surgical). |
| 4 | Thread | Intermittent `POST /api/teams/history 502` → bare `Failed to load resource` console errors during a browse session. | **DEFERRED (environmental)** | The 502s are the **read-only Teams host** flaking on the in-page fetch (transient / cred re-mint), not a UI defect. The UI already handles it correctly: the thread error state ("Could not load messages / Retry") is live-verified, and the 4s poll swallows errors keeping the last-good thread. No product action. |
| 5 | Thread | No **date separators** / no **consecutive-same-sender grouping** (every message shows its sender + time). | **DEFERRED (feature, not a bug)** | Messages are readable and correctly ordered; grouping is a net-new feature, out of scope for a bug-hunt (Workstream D is review-then-fix). Noted for a future polish task. |

## Verified solid (no change)

- **Conversation list**: row heights stable across label chips (`urgent`/`hf`/`new`) — chips are
  `py-px text-[10px]` inline + the fixed `size-10` avatar holds the row min-height; folder headers
  aligned; long titles truncate; unread dot + timestamp aligned; no jitter. Light + dark, both
  densities.
- **Thread**: system lines render as intentional centered meta ("Call ended · 6 people"); generic
  card fallback + AMS media aspect-boxes reserve their box (no load shift); code `pre` has
  `overflow-x:auto`; body is `[overflow-wrap:anywhere]` so long URLs wrap; mention pills styled.
- **Composer**: auto-grow wired (`scrollHeight` capped at 128px), Enter/Shift+Enter, full disabled
  state while sending (textarea + attach + send + remove-chip), image/file pending chip with remove,
  honest failure (draft retained + error copy + retry), "Sending…" indicator. (No sends performed —
  read-only rule honoured.)
- **Keyboard/palette**: ⌘K palette (grouped, hint chips aligned), `?` overlay (grouped
  Navigation/Conversation/Message/App, styled `kbd`), `u` toggle, `g i` sequence. Esc layering is
  correct by construction — `routeKey` never claims Esc, the router early-returns while
  palette/overlay open, and each of palette/overlay/lightbox owns its own Escape.
- **Settings sheet**: theme (System/Light/Dark) + density (Comfortable/Compact) segmented controls +
  push toggle; both live-apply; compact + 390px phone layouts sane.
- **Phone (390px)**: full-width rows, folder headers, stacked list→thread nav — back button
  ("Back to conversations") pops thread → list and `history` reflects `/chat/`.
- **Four-state**: list + thread loading skeletons (shared row/bubble components), empty states,
  thread error + Retry (live-verified against a bogus conv id), populated.
- **Avatars**: fixed `size-10` box, initial behind + photo absolutely on top (no layout shift),
  `onError`→initials, resets on userId change; mixed photo/no-photo rows aligned.
- **Console**: no React key warnings, no exceptions, no failed fetches beyond the environmental
  Teams 502 (#4) and the now-fixed deprecation warning (#3).

## Files changed

- `chat/src/lib/conversation-view.ts` — new pure `navigableConversations` helper.
- `chat/src/chat-app.tsx` — `moveListFocus` walks the navigable (grouped, collapse-filtered) order.
- `chat/src/lib/conversation-view.test.ts` — test for the new helper.
- `chat/index.html` — modern `mobile-web-app-capable` meta.

## Verification

`pnpm test` (1462 passed) · `pnpm typecheck` clean · `pnpm chat:build` ok · `pnpm build` ok ·
`node --check web/server.mjs` ok · biome clean on changed files · `/` build byte-unchanged (no
`src/**` edits).

## Screenshots

`/tmp/psn90-d-*.png` — glory-dark (bug #1 evidence: AMS images), jk-after (bug #2 fix: collapsed
folder + clean focus ring), meeting-light (system lines + media), settings, palette-dark,
shortcut-overlay, phone-list, phone-thread, thread-error.
