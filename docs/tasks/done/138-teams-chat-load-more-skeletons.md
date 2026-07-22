# 138 — teams chat: load-more skeletons + no flicker (list + thread)

- **Status:** done
- **Mode:** HITL
- **Depends on:** t134 (paging), t136 (list infinite scroll)

## Goal

Replace the plain "Loading…" / "Loading older…" text with proper skeleton placeholders while a
next/older page loads, and make the append never shift what the user is looking at. User ask.

## Acceptance criteria

- [ ] Conversation-list infinite scroll shows **skeleton rows** (matching `ConversationRow`
      height/shape) while the next page loads, then the real rows replace them with no visible
      layout collapse/jump.
- [ ] Thread older-page load shows **skeleton message bubbles** at the top while loading; the
      existing scroll-anchor preservation keeps the viewport steady on prepend (no jump).
- [ ] No flicker: the loading→loaded swap reserves stable height (skeleton ≈ incoming content), and
      rapid successive infinite-scroll loads don't flash the indicator on/off.
- [ ] Behavior otherwise unchanged (paging still dedups, stops on null cursor).

## Test plan

- **Layer 1:** n/a — no new pure logic (presentation only; reuse the existing skeleton shapes).
- **Layer 3 (visual, live):** scroll the list → skeleton rows → real rows, no jump; scroll a thread
  to top → skeleton bubbles → older messages prepend, viewport steady. Screenshot both.

## Design notes

- **Contracts changed:** none. `chat/src/components/conversation-list.tsx` +
  `chat/src/components/thread-view.tsx` only.
- Reuse the existing `ListSkeleton` row markup (list) and `ThreadSkeleton` bubble markup (thread) —
  extract a single-row / single-bubble skeleton so the load-more placeholder and the full-screen
  loading state share one shape (no divergence). Show ~3 skeleton rows / ~2-3 bubbles while loading.
- List: keep the IntersectionObserver sentinel; render the skeleton rows inside/adjacent to it while
  `loadingMore`. Ensure new rows insert without moving the viewport (they append below the fold).
- Thread: swap the "Loading older…" text for skeleton bubbles at the top; the existing
  `requestAnimationFrame` scroll-anchor (`scrollTop += scrollHeight - prevHeight`) already prevents
  the jump — verify it still holds with the taller skeleton block.
- **New ADR needed?** No.

## Out of scope

- Media rendering (t139+). The 12s list poll re-sort stability (a separate concern; only if it
  visibly jumps — revisit under UI polish). Virtualization.

## Definition of Done

- [ ] Layer 3 shots (list + thread, loading and loaded). `pnpm typecheck` / biome (touched) /
      chat build clean.
- [ ] CLAUDE.md: only if a described behavior changes materially (skeleton is minor — a one-clause
      note on the list/thread load-more affordance is enough). No AI attribution.
- [ ] Task → done, `t138` in commit.

## Notes

- Worktree: docs on `main`, code on feature branch (2-commit ship); `--no-verify` (rtk breaks
  pre-commit); never `git add -A`.
