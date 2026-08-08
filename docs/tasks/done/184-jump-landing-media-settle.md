# 184 — hold the jump landing while media settles

- **Status:** done
- **Mode:** AFK
- **Estimate:** 0.5d
- **Depends on:** none
- **Blocks:** none

## Goal

Jumping to a message — from a citation chip, a reply quote, a message link, or a `?msg=` deep link — often lands off-target: the message scrolls past, or ends up above the viewport. After this task the landing is held: the target is re-seated as nearby media finishes decoding, so the jump ends where it aimed.

## Why now

Every jump affordance in the app funnels through one function, so a single defect degrades citations, reply quotes, deep links and (as of t183) message links at once. The failure is worst exactly when the jump matters most — a media-heavy thread you can't easily scroll back through by hand.

## Acceptance criteria

- [x] Jumping to a message in a thread containing unsized images lands on that message
- [x] Jumping to a message that was NOT loaded in the session (jump-mode window fetch) lands correctly
- [x] The correction is invisible as motion — no second animated scroll after the first
- [x] A second jump fired during the first one's settle window wins outright
- [x] Leaving the thread mid-settle tears the listener down (no leak, no stray scroll on a dead pane)
- [x] A jump in a thread with no media behaves exactly as before

## Test plan

### Layer 1 — Pure logic (TDD)

n/a — this is DOM scroll behavior; the mechanism (a capture-phase `load` listener plus a settle timeout) has no pure core to extract. Covered by Layer 2/3.

### Layer 2 — Manual smoke (CDP/IPC)

- [x] Jump into a thread of unsized images — target centered after load
- [x] Jump to a message far outside the loaded page — window fetch, then centered
- [x] Fire a second jump mid-settle — the second target wins
- [x] Switch conversations mid-settle — no stray scroll afterwards

### Layer 3 — Visual review

- [x] Landing looks like the layout holding still, not a bounce

## Design notes

The jump scrolled the moment the target row existed in the DOM, which is earlier than the moment the layout above it is final. An image or video with no reserved box occupies zero height until it decodes and then grows, pushing everything below it — including the target — down by an unpredictable amount.

- **Contracts changed:** none — the fix is internal to the thread pane
- **New modules:** none
- **New ADR needed?** no

The same defect was found and fixed for the unread separator long ago, and the fix carried a comment naming the cause exactly ("Images without reserved boxes grow as they load and shove the separator off-target"). The message jump simply never inherited it. This task brings the two into line and adds what the original lacked: a cancel token, so overlapping jumps and unmount tear down cleanly instead of leaving listeners fighting over the scroll position.

Re-seat uses instant scrolling rather than smooth: a smooth correction reads as a second animation and looks like a bug, while an instant one reads as the page holding still. The target row is re-queried on each correction because a re-render or a jump-window swap can replace the node.

t181 reduces how often this triggers — uploaded images now carry `width`/`height`, so their boxes are reserved — but it cannot eliminate it: images from other clients, and any media whose dimensions are unknown, still grow on load.

## Out of scope

- Reserving boxes for ALL inbound media by probing dimensions server-side — a much larger change, and the settle window is needed regardless for media whose size cannot be known ahead of time
- Scroll anchoring via CSS `overflow-anchor` — the pane is `flex-col-reverse`, where anchoring behavior is inconsistent across browsers

## Definition of Done

- [x] Layer 2 smoke checklist completed
- [x] Layer 3 landing verified
- [x] `pnpm check` clean
- [x] `pnpm typecheck` clean
- [x] `pnpm test` green
- [x] No commented-out code, no `console.log` debris, no AI attribution
- [x] Task closed: status → done, file moved to `docs/tasks/done/`, t184 in commit

## Notes

The settle window is time-boxed rather than driven by a load count. A thread can always contain one more image than expected, and an unbounded listener would keep yanking the scroll position long after the user took over.

Worth remembering: the fix already existed in this file, twenty lines away, with a comment explaining the exact failure. The bug was not a missing insight — it was a fix that never got applied to its sibling.
