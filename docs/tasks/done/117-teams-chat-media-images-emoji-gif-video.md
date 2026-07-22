# 117 — teams chat media: inline images (AMS proxy) + emoji/GIF/sticker sizing + video + lightbox

- **Status:** done
- **Mode:** HITL
- **Depends on:** t111 (rich HTML render + DOMPurify)
- **Blocks:** t118 (files, cards, call-recording, system messages)

## Goal

Inline visual media renders in the thread: AMS-hosted images/video load through an authenticated
proxy; public-CDN emoji/GIFs/stickers render at the right size; images open in a lightbox. User ask
("media support"). This is the inline-visual half; files/cards/call-recording/system messages are t118.

## PROVEN shapes + auth (probed live 2026-07-21 — use verbatim)

- **AMS image**: `<img itemtype="http://schema.skype.com/AMSImage" src="https://as-api.asm.skype.com/v1/objects/{objId}/views/imgo" width height>` (also `https://as-prod.asyncgw.teams.microsoft.com/.../views/imgo`). A bare `<img src>` from our origin **401s**.
  - **AUTH — the one working path (verified)**: fetch the AMS url **IN-PAGE** (side-channel `Runtime.evaluate`) with header `Authentication: skypetoken={sk}` → **200 image/jpeg**. Server-side node fetch 401s (token session/CA-bound); `mode:'no-cors'` 401s (strips the header). So media MUST be fetched in-page, like every other Teams call.
- **AMS video**: `<video src="https://as-prod.asyncgw.teams.microsoft.com/v1/objects/{objId}/views/video" itemtype="http://schema.skype.com/AMSVideo" data-duration="PT27S" width height>` — same AMS auth as images.
- **Custom emoji** (PUBLIC, no auth): `<img itemtype="http://schema.skype.com/Emoji" itemid="giggle" class="animated-emoticon-20-giggle" src="https://statics.teams.cdn.office.net/evergreen-assets/personal-expressions/...">`.
- **GIF** (PUBLIC): `<img src="https://media1.giphy.com/media/.../giphy.gif" width height alt style>`.
- **Sticker** (PUBLIC): `<img itemtype="http://schema.skype.com/Sticker" src="https://statics.teams.cdn.office.net/evergreen-assets/stickerassets/.../Clippy_Bored.gif">`.

## Scope

### Server — media proxy (in-page, CA-proof)
- **`core/teams-media.js`** (pure, TDD): `isValidAmsUrl(url)` — SSRF gate: https + host ∈ {`as-api.asm.skype.com`, any `*.asm.skype.com`, any `*.asyncgw.teams.microsoft.com`} + path starts `/v1/objects/`. `amsObjectId(url)` helper. `rewriteMediaHtml(html)` — rewrite `<img>`/`<video>` whose `src` is an AMS/asyncgw object URL → `/api/teams/media?url={encodeURIComponent(src)}`; leave PUBLIC-CDN srcs (giphy/statics.teams.cdn.office.net) untouched. Returns the rewritten HTML.
- **`web/server.mjs` `GET /api/teams/media?url=`**: validate with `isValidAmsUrl` (reject → 400). LRU cache keyed by url (objId is immutable). Miss → `notificationCenter.runInTeamsPage` a fetch of the url with `Authentication: skypetoken=` header, read the body in-page as a data URL (`FileReader.readAsDataURL` on the blob — handles any content-type, avoids call-stack overflow of `String.fromCharCode(...huge)`), return `{ ct, dataUrl }`; server decodes the base64 → `Buffer` → cache → respond with the `Content-Type` + `Cache-Control: public, max-age=604800, immutable`. 401 in-page → one re-authz + retry (mirror teamsHistory), then 502. Cache cap ~64 entries / ~64MB, evict LRU.
- **`core/teams-render.js`**: run `rewriteMediaHtml` on the rendered HTML so the emitted body points `<img>`/`<video>` at the proxy (AMS) or the public CDN (untouched).

### Client — rendering + lightbox
- **`chat/src/index.css`** (the `.teams-message-body` scope): size media by kind —
  - `img[itemtype*="Emoji"]` → inline, `height: 1.25em; width: auto; vertical-align: -0.2em; display: inline`.
  - `img[itemtype*="Sticker"]` → `max-height: 140px; width: auto`.
  - other `img` (AMS proxied + giphy) → `max-height: 320px; max-width: 100%; border-radius; cursor: zoom-in; display: block`.
  - `video` → `max-height: 360px; max-width: 100%; border-radius`.
- **`chat/src/components/message-row.tsx`**: after the sanitized `dangerouslySetInnerHTML`, add a delegated click handler — a click on an `img` that is NOT emoji/sticker opens a **lightbox** with that image's src. (Emoji/sticker/video clicks do nothing special.)
- **`chat/src/components/image-lightbox.tsx`** (new): a fixed full-screen overlay (dimmed backdrop, centered `img` at natural size capped to viewport, click backdrop or Esc to close). Minimal, shadcn-styled, theme-aware.
- **`chat/src/lib/sanitize-message.ts`**: ensure `img` keeps `itemtype`/`class`/`width`/`height`/`alt` (for the CSS selectors) and `video` + `src`/`controls`/`width`/`height` are allowed; same-origin proxy src + the public CDN hosts pass the link-hardening hook (don't strip them). Keep the existing XSS hardening.

## Acceptance criteria

- [ ] An AMS image renders inline (loads via the proxy, no 401) as a capped thumbnail; clicking it opens a lightbox; Esc/backdrop closes.
- [ ] Custom emoji render inline at text size (not giant); GIFs + stickers render at a sensible size.
- [ ] An AMS `<video>` renders an inline playable `<video controls>` via the proxy.
- [ ] The proxy rejects a non-AMS `url` (SSRF gate, 400) and never fetches an arbitrary host in-page. TDD.
- [ ] Repeat views of the same image don't re-fetch (LRU cache hit).
- [ ] No XSS regression — a `<script>`/`onerror`/`javascript:` in content is still stripped.

## Test plan

- **Layer 1 (TDD, `core/teams-media.js`)**: `isValidAmsUrl` (accept asm/asyncgw https `/v1/objects/…`; reject other host, non-https, non-object path, the public CDNs); `rewriteMediaHtml` (AMS img/video → proxy url; giphy/statics untouched; malformed src left alone).
- **Layer 2 (live keeper, orchestrator)**: proxy returns 200 image bytes for a real AMS object; an image in the self-note chat renders; a rejected url 400s.
- **Layer 3 (visual)**: thread with an image (thumbnail + lightbox), emoji inline-sized, a GIF, a video. Screenshot.

## Design notes

- **New modules**: `core/teams-media.js` (pure url gate + html rewrite), `chat/src/components/image-lightbox.tsx`. Proxy endpoint in `web/server.mjs`. No new ADR (within ADR-0018; the in-page-fetch-proxy is the same CA-proof pattern as the rest).
- The proxy fetches in-page and returns bytes so the client `<img src="/api/teams/media?...">` loads + browser-caches normally (no giant data URLs in the DOM). LRU on the server avoids re-hitting the side-channel per scroll.
- **Ceilings** (`ponytail:`): proxy serves the full `imgo`/`video` object (no thumbnail-view optimization, no HTTP range/seek for video — a 27s clip is small; big-video streaming + range is deferred). blurHash placeholder deferred. Call-recording (URIObject), files, cards, system messages → **t118**.

## Out of scope (→ t118)

- SharePoint file chips (`properties.files`), Swift/adaptive cards, call-recording (URIObject thumbnail + open-in-Teams), `ThreadActivity/*` system-message rendering (currently raw JSON — real gap, next task).

## Definition of Done

- [ ] Layer 1 green (gate + rewrite). Layer 2 live (proxy 200 + reject). Layer 3 shots.
- [ ] `pnpm check`(touched)/`typecheck`/`test`/`node --check web/server.mjs`/chat build clean.
- [ ] CLAUDE.md updated (media proxy + in-page AMS fetch + public-CDN media + lightbox). No AI attribution.
- [ ] Task → done, `t117` in commit.

## Notes

- Worktree: docs on `main`, code on feature branch (2-commit ship); `--no-verify`; never `git add -A`.
- AMS auth PROVEN: in-page `Authentication: skypetoken={sk}` → 200; server-side + no-cors → 401. Probes: scratchpad probe-media*.mjs.
