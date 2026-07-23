# 132 — teams chat instant channel switch + scroll-persist (keep-alive threads)

- **Status:** done
- **Mode:** HITL
- **Depends on:** t129 (thread pane), t131 (names)
- **Blocks:** UI polish

## Goal

Switching conversations is **instant** and **scroll position persists** per conversation.
Today the thread pane unmounts + refetches on every switch (a beat of latency, scroll
jumps to bottom). Fix (user-requested design, feedback #4): once a conversation is opened,
keep its thread mounted in its own div, hidden when inactive; switching just toggles which
div is visible — no refetch, no remount, scroll retained. Lazy (mount on first open only)
and capped (bounded keep-alive set, evict least-recently-viewed).

## Scope

- **`chat/src/lib/thread-keepalive.ts`** (pure, TDD): an MRU keep-alive model (mirror
  `src/lib/active-order.ts` + the `closed-tabs.ts` cap). `openThread(state, convId, cap)` →
  `{ mounted: string[], active: string }` — adds `convId` (marks active + most-recent), and
  when `mounted.length > cap` evicts the least-recently-viewed id (that thread unmounts →
  re-fetches on its next open). `isMounted(state, id)`. Cap constant `KEEPALIVE_CAP` (~8).
- **`chat-app.tsx`** — replace the single active `ThreadView` with: render a `ThreadView`
  for **each mounted convId** (keyed by convId), only the active one visible. Inactive
  threads stay mounted but hidden (`hidden`/`display:none`) so their DOM + scroll survive.
  Opening a conversation calls `openThread`; first open mounts+fetches, re-open is instant
  (already mounted). Phone: same, but the whole pane is hidden when the list is shown.
- **Scroll persistence** — keeping the thread mounted preserves its scroll. If a
  `display:none` toggle drops `scrollTop` on any target browser, `thread-view.tsx` saves
  `scrollTop` on hide and restores on show (a ref + effect keyed on active). Verify the
  round-trip (open A, scroll up, open B, back to A → A's scroll retained).
- **Instant switch** — because the target thread is already mounted with its data, a
  re-open is a visibility toggle only (no network, no remount).

## Acceptance criteria

- [ ] Re-opening a previously-viewed conversation is instant (no loading state, no refetch)
      and shows its prior scroll position.
- [ ] First open of a conversation mounts + fetches (normal loading state).
- [ ] At most `KEEPALIVE_CAP` threads stay mounted; the least-recently-viewed evicts (and
      re-fetches on its next open).
- [ ] Only the active thread is visible; inactive ones are hidden, not unmounted.
- [ ] `thread-keepalive` MRU + cap/evict is TDD-covered.

## Test plan

- **Layer 1 (TDD):** `thread-keepalive` — open adds+activates, re-open promotes to
  most-recent without duplicating, cap evicts the LRU, active tracking.
- **Layer 3 (visual, REQUIRED):** open conv A → scroll up → open conv B (instant, its own
  scroll) → back to A → A shows the SAME scroll position (no jump, no reload). Screenshot
  the before/after of A's scroll.

## Design notes

- Same keep-alive pattern as the local-tabs webviews (`src/components/local-webviews.tsx`:
  mounted, only active shown, others `display:none`) — proven to preserve live state.
- The cap bounds memory (a heavy user opening 50 chats keeps only the last ~8 mounted),
  mirroring `closed-tabs.ts`'s bounded stack.
- Pure model + effectful render split (like `active-order.ts` / `tab-lifecycle.ts`):
  `thread-keepalive.ts` decides mount/evict; `chat-app.tsx` renders it.
- No backend, no new API. Covered by ADR-0019.

## Out of scope

- Live-updating a mounted-but-hidden thread with new messages (that's t131-sweep/realtime).
- Rich-HTML render, list pagination, UI polish (separate tasks).

## Definition of Done

- [ ] Layer 1 green; Layer 3 scroll-persist + instant-switch screenshots.
- [ ] `pnpm check`(touched)/`typecheck`/`test`/`chat:build`/`/` build unchanged.
- [ ] CLAUDE.md updated (keep-alive threads). No AI attribution / console debris.
- [ ] Task → done, moved to `done/`, `t132` in commit.

## Notes

- Worktree: docs on main, code on feature branch (2-commit ship); never `git add -A`;
  `--no-verify` (rtk breaks pre-commit).
