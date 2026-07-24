# PSN-98 — [chat] Labels & Folders persistency & notification sounds (plan)

Status: grilled — decisions resolved · plan-only · 2026-07-24
Issue: https://linear.app/withdustin/issue/PSN-98

Two bugs (prod persistence wipe, Electron reload button) + two features (notification
sounds, notify-while-active) for the `/chat` Teams app. Research is scoped to these
areas only — no general chat audit this round.

## Baseline (probed 2026-07-24, code + live)

- **Labels/folders storage**: `conversation_prefs` table in the server SQLite store
  (`core/teams-store.js`, `web-teams.db`), read/written via `/api/teams/prefs`
  (`chat/src/lib/use-conv-prefs.ts`). Folder-collapse view-state is per-device server
  ui-state (`chatFolders_<deviceId>`).
- **Persistence root cause — CONFIRMED**: the Dokploy Application (`cdp-browser-app`,
  `RLo7fiU3_7tzBthG7OEV8` on `dokploy-dell01`) builds from `Dockerfile` with
  `mounts: []` and env `CDP_HOST/CDP_PORT/PORT/APP_TITLE` only — **no `DATA_DIR`, no
  volume**. t163's `DATA_DIR` support is in the shipped code (prod serves `8cb6b34`)
  but unset, so `web-teams.db`, `web-settings.json`, `web-notifications.json`, push
  subs, and Slack sweep state all live in container FS at `/app` and every redeploy
  wipes them. Live check: `GET /api/teams/prefs` on prod returns `{"prefs":{}}`.
  `docker-compose.yml` (unused by Dokploy) already models the correct setup
  (`/data` volume + `DATA_DIR=/data`).
- **Reload button**: `chat-app.tsx` header → `chat-preload.js` → `chat:reload` in
  `chat-main.js` (unregister SW + drop caches via awaited `executeJavaScript`, then
  `reloadIgnoringCache`). Observed failure: **nothing visible happens**. Prime
  suspect: the awaited `executeJavaScript` promise never resolves (SW/caches op
  hangs), so `reloadIgnoringCache` is never reached; no timeout guards it.
- **Notification sounds**: none exist anywhere (no Audio/sound code in `chat/`).
- **Notify gating**: `chat-app.tsx` `onConversations` fires notifications only when
  `!document.hasFocus()`. It does **not** check per-conversation mute
  (`isMutedNow`) or `notifyOnMention` — muted conversations still notify via the
  Electron shell / web-foreground path (the t147 push sweep is mute-aware
  server-side; this local path is not).
- **Settings pattern**: per-device chat settings persist in server ui-state
  (`chat/src/lib/chat-settings.ts` + `use-chat-settings.ts`, e.g.
  `chatTheme_<deviceId>`) — localStorage alone is unreliable on the iPad PWA.

## Decisions (grilled 2026-07-24)

1. **Infra fix ownership**: agent performs the Dokploy mutation in build phase —
   add `/data` volume mount + `DATA_DIR=/data` env via the Dokploy REST API,
   **asking explicit approval before the mutation**, then redeploy and verify.
   API access: `https://dokploy.dustin.one/api`, key from Proton Pass
   (`pass://Personal/dokploy/api_key`), exported per-session — never on disk,
   never in a commit; responses filtered with `jq` (API returns secrets cleartext).
2. **Sound surfaces**: Electron shell + web foreground only. Background web push
   keeps the OS default sound (SW custom audio is unreliable/no-op on iOS).
3. **Sound design**: 3–4 bundled short CC0 chimes + **None**, picker in the
   Settings sheet with preview-on-select, default = first sound. Persist
   per-device via the existing chat-settings ui-state pattern.
4. **Notify-while-active**: focused app still notifies (banner + sound) for
   messages in conversations **other than the one currently open/visible**; the
   open thread stays silent. Applies to both Electron shell and web foreground
   (same code path).
5. **Reload bug repro**: "nothing visible happens" on click.
6. **Research scope**: best-practice research applied to these four areas only;
   no general chat-app audit, no extra feature builds this issue.

## Workstreams

Each sized for one session. Same branch, same PR throughout.

### A — Prod persistence fix (bug)

1. Boot-time guard: when `NODE_ENV=production` and `DATA_DIR` is unset,
   `web/server.mjs` logs a loud warning; expose `dataDir` presence in
   `/api/version` (e.g. `"persistent": true|false`) so persistence is verifiable
   remotely.
2. Dokploy mutation (approval-gated, per decision 1): add volume mount
   `cdp-web-data → /data` + env `DATA_DIR=/data` on `cdp-browser-app`; redeploy.
3. Verify: create a label + folder on prod, trigger a second redeploy, confirm
   `GET /api/teams/prefs` still returns them and `/api/version` reports
   persistent.

Note: previously-created labels/folders are unrecoverable (already wiped).

### B — Electron reload button (bug)

1. Reproduce on the installed CDP Chats shell (`pnpm dist:chat` /
   `scripts/install-local.sh`).
2. Root-cause: instrument `chat:reload`; expected culprit is the un-timed-out
   awaited `executeJavaScript`. Fix once in the handler (e.g. `Promise.race`
   with a short timeout so `reloadIgnoringCache` always runs).
3. Add visible feedback (the reload itself is the feedback once it fires; if a
   delay remains, a brief disabled/spinner state on the header button).
4. Verify: click reloads, and a stale-SW scenario force-fetches the new build.

### C — Notification sounds (feature)

1. Source 3–4 short CC0 chimes (`chat/public/sounds/*.mp3`), plus **None**.
2. `chat/src/lib/notify-sound.ts`: pure selection + an `Audio`-playing effect
   seam; unit-test the pure part.
3. Settings sheet: "Notification sound" picker (radio/segmented list),
   preview-on-select, persisted per-device via chat-settings.
4. Wire into the notify path (both shell and web-foreground branches). When a
   custom sound plays in the Electron shell, pass `silent: true` to the native
   `Notification` so macOS doesn't double-sound; **None** = silent notification
   banner only.
5. Verify live on Electron shell + web.

### D — Notify while active + mute correctness (feature)

1. Replace the `!document.hasFocus()` gate: notify when the arrived message's
   conversation ≠ the currently open/visible conversation (focused or not).
   Keep suppressing for the open, visible thread.
2. Respect prefs in the local notify path: skip `isMutedNow` conversations,
   honor `notifyOnMention` override — closing the discovered mute gap.
3. Pure predicate (`shouldNotify(conv, openConvId, visible, prefs)`) in
   `chat/src/lib/notify-new.ts` (or sibling), unit-tested.
4. Verify live: message to open thread = silent; message to another conversation
   while app focused = banner + sound; muted conversation = silent.

### E — Bug sweep + ship (last)

1. Regression sweep across the four areas + `pnpm test`, `typecheck`,
   `check:changed`, `test:e2e`.
2. Apply scoped best-practice findings (sound UX niceties that fit — e.g. cap
   notification burst, no sound spam on multi-arrival) if trivial; else log as
   ideas.
3. Retitle PR to the epic, mark Ready, set issue In Review.

## Dependencies / parallelism

| Workstream | Depends on | Parallel with |
|---|---|---|
| A persistence | — (needs approval for mutation) | B, C, D |
| B reload | — (needs local Electron install) | A, C, D |
| C sounds | — | A, B |
| D notify-active | C (plays the chosen sound) | A, B |
| E sweep | A–D | — |

## Acceptance criteria

- [ ] Prod `/api/version` reports persistent storage; labels + folders survive a
      redeploy (verified with a real redeploy cycle).
- [ ] Boot warning fires when `DATA_DIR` is unset in production.
- [ ] Electron reload button visibly reloads and force-fetches a fresh build.
- [ ] Settings offers 3–4 sounds + None with preview; choice persists per device
      across refresh/reinstall.
- [ ] New message → chosen sound plays (Electron shell + web foreground); no
      double sound from the OS.
- [ ] Focused app notifies for non-open conversations; open thread stays silent.
- [ ] Muted conversations never notify locally; `notifyOnMention` punches through.
- [ ] Vitest + typecheck + Biome (changed) + e2e green; live verification on the
      probe host (`100.85.206.8:9222`) done per workstream.

## Risks

- **Dokploy API key = homelab master credential** (returns all secrets
  cleartext). Session-only env, jq-filtered reads, approval-gated single
  mutation.
- **First redeploy after the volume mount still starts empty** — user-visible;
  say so in the Linear comment, don't chase a "bug".
- **Preview deploys lag pushes** — verify served `sha` via `/api/version` before
  debugging "still broken".
- **Electron live verification** needs a local packaged install (Node 22 via
  nvm for packaging; rebuild `better-sqlite3` on module-version mismatch).
- **Autoplay policy on web**: `Audio.play()` may need a prior user gesture;
  first interaction with the app (opening it) normally satisfies it — verify on
  Safari/iPad.

## Out of scope

- Restoring the already-wiped labels/folders (data is gone).
- Custom sounds in the web-push SW / background iOS PWA.
- General world-class chat audit / new enhancement builds beyond the four seeds.
- Any mutation on other users' threads (self-chat only for live tests).
