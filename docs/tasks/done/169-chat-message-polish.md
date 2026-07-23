# t169 — Message polish (asymmetric corners, compact radius, staggered arrival)

Status: done
Scope: `/chat` only. The `/` browser build is byte-unchanged.
Plan: PSN-95 workstream F. Grilled: #12 (~100ms stagger, cap ~5, own sends never,
reduced-motion off).

## What shipped

- **Bubble geometry** (`chat/src/index.css` owns the radius now, not a Tailwind
  class): base radius `--bubble-r` (1rem; **0.7rem in compact density**), and a
  same-sender run gets Messenger-style **asymmetric corners** — the corners facing
  a group neighbour tighten to `--bubble-tight` (0.3rem), driven by
  `data-pos` (solo/first/middle/last) + `data-side` (self/other) on the bubble.
- **Group positions** (`chat/src/lib/thread-group.ts`, pure, TDD): a second pass
  over the built thread items stamps each chat message's `groupPos` — runs derive
  from the item sequence alone (separators/system lines already force the next
  message to be a leader).
- **Staggered arrival** (`thread-view.tsx`): when one 4s poll delivers several new
  messages, each fresh row fades/slides in with a ~100ms per-index delay (cap 5,
  rest instant) via `motion`. "Fresh" = unseen id AND newer than the newest
  previously-seen ts, so an older-page prepend never staggers; own/pending/system
  never stagger; the first load seeds silently; `prefers-reduced-motion` disables.

## Verification

- `vitest run chat/src` — 205 pass (4 new groupPos cases: solo, first/middle/last,
  sender-change split, gap split).
- `tsc --noEmit` clean; biome exit 0; `pnpm chat:build` succeeds.
- Visual check (both densities, light/dark, burst arrival) in the G sweep.

## Known ceilings / carry-overs

- Stagger animates row entry only — no scroll-follow choreography per revealed
  row; the existing stick-to-bottom re-pin covers the burst as a whole.
