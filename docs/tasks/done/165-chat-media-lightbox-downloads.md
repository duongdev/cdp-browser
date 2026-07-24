# t165 — Media: video lightbox + downloads

Status: done
Depends on: t164
Scope: `/chat` only. The `/` browser build is byte-unchanged.
Plan: PSN-95 workstream B.

## What shipped

- **Video in the lightbox**: inline AMS video now renders as a **poster frame** (no
  inline controls — a native `<video controls>` bar swallows the tap) and opens the
  shared lightbox on tap, where it plays with native controls + autoplay. Sanitizer
  (`chat/src/lib/sanitize-message.ts`) drops `controls`, keeps `preload=metadata`,
  and tags `.teams-video`; `message-row.tsx`'s delegated body-click routes a `VIDEO`
  tap to `setLightboxMedia({ src, kind: "video" })`.
- **Lightbox media model**: `ImageLightbox` now takes `media: { src, kind } | null`
  (was `src`). Image kind keeps the t164 zoom/pan; video kind renders a native
  `<video autoPlay controls>` (pointer events go to the controls, backdrop click
  closes, `stopPropagation` on the video so a control tap never closes).
- **Download**: a download button in the lightbox chrome (image + video) — same-origin
  proxy URL (`/api/teams/media?url=…`) + `<a download>` forces a save.

## Verification

- `vitest run chat/src/lib/sanitize-message.test.ts chat/src/lib/lightbox-zoom.test.ts`
  — 24 pass (video poster assertion updated to no-controls + `.teams-video`).
- `tsc --noEmit` clean; biome clean (4 `!`/format warnings, file-consistent).
- `pnpm chat:build` succeeds.
- Live/HITL: on-device video playback + download deferred to the workstream-G sweep.

## Known ceilings / carry-overs

- Download `download` attr force-saves only same-origin bytes (the AMS proxy). A
  public-CDN GIF (giphy, cross-origin) opens in a new tab instead — acceptable; the
  vast majority of chat media is AMS-proxied.
- Files/PDF/recordings stay SharePoint link-out (t141/t162, per grill Q8/Q9).
- The media proxy is whole-blob, no Range (unchanged) — fine for chat clips, wrong
  for long recordings (which link out).
