# t170 — Chat UI part 2: bug sweep + verification

Status: done
Depends on: t164–t169
Scope: `/chat`. Plan: PSN-95 workstream G.

## Findings + fixes

- **Facepile rows exploded with the avatar dot** (user-reported on the preview):
  the t168 dot wrapper was a bare inline `<span>`; `FacepileAvatar`'s root had no
  display class, so outside a direct flex item its `size-10` was ignored and the
  absolute circles anchored to a collapsed box, spilling across neighbouring
  rows. Fix: the wrapper is an explicitly sized block and `FacepileAvatar`'s root
  is `block` (robust in any container). Redesign while at it: facepile circles
  moved to top-RIGHT + bottom-LEFT (26px, was 28px at TL/BR) so the unread dot
  anchors a circle exactly like the single avatar and letters aren't clipped by
  the overlap. Verified with a playwright harness against the built app
  (mocked `/api/teams/*`), light + dark, single/facepile/read/mention rows.

- **Lightbox wheel-zoom scrolled the page behind** (found in review, fixed here):
  React root-attaches `wheel` listeners passively, so the React `onWheel`'s
  `preventDefault` silently failed. Wheel zoom now rides a **non-passive native
  listener** on the stage element (image stages only; a video stage has no wheel
  behavior).
- Formatting drift in `image-lightbox.tsx` caught by the CI-shaped
  `check:changed` gate; fixed.

## Verification (full gate)

- `pnpm typecheck` — clean.
- Unit: `vitest run src chat/src core scripts` — **1484 pass** on Node 22;
  `core/teams-store.test.ts` (native better-sqlite3, built for Node 24 in this
  worktree) — **36 pass** on Node 24. The Node-22 failures are the module-version
  mismatch only (memory: rebuild on mismatch; CI is green on one Node).
- E2E: `pnpm test:e2e` — **49 pass** (Node 24; server boots + serves; the same
  native-module mismatch explains the Node-22 timeouts).
- `BIOME_SINCE=origin/main pnpm check:changed` — exit 0.
- `pnpm build` + `pnpm chat:build` — clean. `node --check web/server.mjs` — OK.

## Deferred to human verification (needs a live device/deploy)

- iPad pinch-zoom + lightbox open/close animation feel (t164).
- Video playback + download save on-device (t165).
- Profile card field coverage against the real tenant directory + the presence
  probe (t166 ceiling).
- Push-through-mute on a real @mention (t167) — needs a live mention event.
- Avatar-dot/mention-badge/filters visual pass in light/dark + compact (t168/t169)
  on the preview deploy.
