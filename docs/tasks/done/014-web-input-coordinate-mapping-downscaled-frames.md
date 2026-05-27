# 014 — correct input coordinates for downscaled screencast frames

- **Status:** done
- **Mode:** HITL
- **Estimate:** 0.5d
- **Depends on:** none
- **Blocks:** none

## Goal

Mouse clicks and hover landed at the wrong place on the remote page (most visibly
in the web build): the page reacted somewhere other than where the user clicked.
Root cause — `toRemoteCoords` mapped a canvas point to *frame-buffer pixels* and
sent those straight to CDP as if they were the remote page's DIP (CSS px). That
only holds when the Screencast Frame is 1:1 with the remote layout viewport. The
web proxy caps `Page.startScreencast` at the local canvas size, so when the remote
window is larger the frame is **downscaled** and the mapping is off by the
downscale ratio — clicks compress toward the top-left. After this task the map
scales frame-px → remote DIP using the frame metadata's `deviceWidth`/`deviceHeight`,
so input lands where the user points regardless of downscale.

## Why now

Surfaced once t013 made web input responsive enough to actually aim — the lag had
masked it. A browser whose clicks land elsewhere is unusable; this is the gate to
the web build being a daily driver.

## Acceptance criteria

- [x] `toRemoteCoords` maps frame-px → remote DIP using the frame's device size when
      provided; clicks/hover land where the user points on a downscaled frame.
- [x] Backward compatible: with no device size (or device size == frame size) the
      result is identical to before, so the Electron path is unchanged.
- [x] `devicePixelRatio` proven to cancel out of the math (not a source of offset).
- [x] `pnpm test` / `pnpm typecheck` / `pnpm check` (touched files) green.
- [x] Confirmed correct in the live web build by the user.

## Test plan

### Layer 1 — Pure logic (TDD)

- [x] `viewport-transform` `toRemoteCoords` — scales image-px to remote DIP when the
      frame is downscaled; is identity when device size == frame size; subtracts
      `offsetTop` on the y axis; existing dpr/letterbox cases unchanged.

### Layer 2 — Manual smoke (CDP/IPC)

n/a — no main-process change. The server already forwards `Page.screencastFrame`
metadata over SSE; the renderer simply stops discarding it.

### Layer 3 — Visual review

- [x] `pnpm web` against a live Remote Browser whose window is larger than the local
      canvas: clicking a known element activates that element; hover states land
      correctly. Confirmed by the user ("it's perfect now").

## Design notes

- **Contracts changed:** `toRemoteCoords(client, rect, dpr, frame, device?, offsetTop?)`
  — two optional params; old 4-arg calls behave as before. `ScreencastFrame` gains an
  optional `metadata: ScreencastMetadata` (`deviceWidth/deviceHeight/offsetTop/
  pageScaleFactor/scrollOffsetX/scrollOffsetY`), populated from the raw CDP frame.
- **New modules:** none.
- **New ADR needed?** no — coordinate-mapping correctness, not an architectural choice.

```ts
// frame-buffer px → remote DIP (CSS px), the space CDP input wants
const k = device ? device.w / frame.w : 1   // deviceWidth / frameWidth
remote = { x: round(ix * k), y: round(iy * k - offsetTop) }
```

## Out of scope

- `pageScaleFactor` / pinch-zoom and `scrollOffset` handling (desktop pages are 1.0 /
  viewport-relative; the metadata fields are plumbed for a future need).
- A synthetic remote cursor overlay (the OS cursor over the canvas already shows the
  pointer; correct mapping was the actual fix).

## Definition of Done

- [x] Layer 1 tests green; `pnpm typecheck` clean; Biome clean on touched files.
- [x] Live web build confirmed by the user.
- [x] CLAUDE.md ("Mouse position mapping") + `src/lib/CLAUDE.md` updated.
- [x] No AI attribution; shipped with t013 in one commit.

## Notes

The decisive reasoning step: `dpr` cancels in `toRemoteCoords` (canvas backing =
`rect·dpr`, letterbox scale divides by the same `dpr`), so a scale error can only come
from frame-vs-viewport size — which pointed straight at the downscale. Matches Chrome
DevTools' own screencast input mapping (`deviceWidth` + image natural width).
