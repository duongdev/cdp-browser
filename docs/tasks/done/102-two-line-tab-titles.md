# 102 — two-line tab titles

- **Status:** done
- **Mode:** AFK
- **Estimate:** 0.1d
- **Depends on:** none
- **Blocks:** none

## Goal

Sidebar tab rows (CDP tabs + local tabs) show the title on a **fixed two lines** instead of a
single truncated line — long titles clamp to two lines with an ellipsis, and short titles still
reserve the second line so every row has a uniform two-line height.

## Change

`src/components/sidebar.tsx` only, four class edits (no logic):

- The two tab-row title spans (`RowLabel` drag-overlay + the CDP/local row `displayTitle` spans):
  `truncate` → `line-clamp-2 min-h-[2lh]`. `line-clamp-2` clamps long titles at two lines;
  `min-h-[2lh]` reserves two line-heights so a short title still occupies a two-line-tall row.
- The tab-row containers + the drag-overlay `RowShell`: `items-center` → `items-start`, so the
  favicon aligns to the first line rather than the vertical middle of the taller row.

Pins are unaffected (they render as favicon-only tiles, no title line). The hover tooltip already
used `line-clamp-2`. The flex row has no fixed height, so it grows to fit the two-line title.

## Verification

- [x] `pnpm typecheck` + `pnpm build` green; Tailwind emits `min-height:2lh` into the built CSS;
      Biome clean on the file (pre-existing warnings only).
- [x] CSS behavior reasoned + build-verified; final visual confirmed on the packaged app
      (`pnpm install:local`) and the prod web build after redeploy.

## Out of scope

- Showing a second line of *content* (URL host/path) — the choice was title-wrap, not a subtitle.
- Pin tiles, the collapsed icon rail (`RailTile`), and the notification/inbox rows.
