# 123 — teams chat: send an image attachment (paste from clipboard) via AMS upload

- **Status:** done
- **Mode:** HITL
- **Depends on:** t108 (send), t117 (media proxy/render)

## Goal

Paste (or pick) an image in the composer and send it — it uploads to Teams' AMS store and posts as an
inline image, rendering for everyone. Primary use: **paste from clipboard**.

## PROVEN recipe (captured from a REAL Teams upload + verified end-to-end on the self-note 2026-07-22)

The blocker was NOT the User-Agent — AMS derives the platform id from **`x-ms-migration` +
`x-ms-client-version`** headers; without them it falls back to the UA and 400s. With them (and the
right token) it works. Full flow (ALL run **IN-PAGE** via the side-channel, CA-proof):

1. **Token**: the MSAL access token for **`ic3.teams.office.com`** (scope `Teams.AccessAsUser.All`) —
   read from `localStorage` (key contains `msal.` + `accesstoken` + `ic3.teams.office.com`, use its
   `.secret`). This is a DIFFERENT token from the msg-service skypetoken and the api.spaces bearer.
   (Verified: api.spaces bearer → 401; ic3 token → 201.)
2. **Create object** — `POST {amsV2}/v1/objects/` where `amsV2 = regionGtms.amsV2` (=
   `https://as-prod.asyncgw.teams.microsoft.com`). Headers: `Authorization: Bearer {ic3}`,
   `x-ms-migration: True`, `x-ms-client-version: {ver}`, `Content-Type: application/json`. Body:
   `{"type":"pish/image","permissions":{"{convId}":["read"]},"sharingMode":"Inline","filename":"…png"}`
   → **201** `{"id":"0-ea-…"}`.
3. **Upload bytes** — `PUT {amsV2}/v1/objects/{id}/content/imgpsh` with the SAME auth + `x-ms-*`
   headers, `Content-Type: application/octet-stream`, body = the raw image bytes → **201**. (View for
   upload is `imgpsh`; the display view is `imgo`.)
4. **Send message** — `POST {chatServiceBase}/v1/users/ME/conversations/{convId}/messages` (skypetoken
   auth, like the reply path) with `messagetype:"RichText/Html"` and content
   `<img itemtype="http://schema.skype.com/AMSImage" src="{amsV2}/v1/objects/{id}/views/imgo" itemscope width="W" height="H">`
   (+ any caption text before it) → **201**.
- `x-ms-client-version` captured value = `1415/26061118216`. **`ponytail:`** hardcode this constant;
  AMS accepts it now — if it starts rejecting a stale version, extract the live Teams build version
  from the page. `x-ms-migration: True` is the load-bearing header.

## Scope

### Server
- **`web/server.mjs` `POST /api/teams/upload-image`** `{ convId, filename, base64, contentType, width?,
  height? }` → an IN-PAGE script (mirror the cred flow; the script reads the ic3 token from MSAL +
  the skypetoken/base/amsV2 from `authz`): create object → PUT `content/imgpsh` (decode the base64 in
  the script: `atob → Uint8Array`) → **send** the message with the AMSImage content (+ optional
  `text` caption, HTML-escaped, prepended). Return `{ ok, msgId }` (or a typed error). A single
  atomic endpoint keeps the flow server-owned. 401 on the ic3 fetch → return a typed `invalid_auth`.
- Keep it web-only (Electron stubs, like the rest of `/api/teams/*`).

### Client
- **`chat/src/components/thread-view.tsx`** (composer): a **paste handler** on the composer — on a
  `paste` whose `clipboardData` carries an image (`items`/`files`), read the image as a File, hold it
  as a **pending attachment** (a thumbnail chip above/in the composer with a remove ✕). Also a small
  **image file-pick** button (an `<input type=file accept="image/*">`) for the same pending slot.
- On **Send** with a pending image: read the File → base64 (FileReader) + its natural width/height →
  `POST /api/teams/upload-image` with the caption text → optimistically append an image message
  (body = an `<img>` pointing at the returned image, or a local object-URL preview) → the poll
  reconciles to the server-rendered AMSImage (which routes through the t117 media proxy). Clear the
  pending attachment + the text on success; on failure keep them + an honest error.
- **`chat/src/lib/teams-client.ts`**: `uploadImage(convId, file, text?)` → base64 the file, POST,
  return `{ msgId }` (throw `TeamsApiError` on failure).
- A pure helper worth TDD: `fileToUploadPayload`-style base64 conversion is effectful; but any pure
  bit (e.g. building the AMSImage content string, or picking the image item from a ClipboardEvent) can
  be a small pure function + test.

## Acceptance criteria

- [ ] Pasting an image into the composer shows a pending thumbnail; Send uploads + posts it as an
      inline image that renders (via the media proxy). Verified live on the self-note (send → renders
      → delete, cleaned up).
- [ ] A caption typed alongside a pasted image is included in the same message.
- [ ] Upload failure keeps the pending image + text + shows an error (no silent drop).
- [ ] Non-image paste (text) still works as before (goes into the textarea).

## Test plan

- **Layer 1 (TDD)**: pure helpers — the AMSImage content builder (escapes caption, embeds the img with
  width/height), and the clipboard-image picker (returns the image File from a ClipboardEvent-like
  input, ignores non-image).
- **Layer 2 (live, orchestrator)**: self-note — upload+send an image via the app, confirm it renders,
  delete it. (The recipe is already proven; this confirms the wiring.)
- **Layer 3 (visual)**: pending-thumbnail chip, sent image in the thread.

## Out of scope

- Arbitrary **file** attachments (non-image) — those upload to **SharePoint** (`addStub` → PUT to the
  personal drive `Microsoft Teams Chat Files` → `StartUpload` chunked; a separate, heavier flow seen
  in the same capture). Follow-up task. Multiple images per message; drag-drop; GIF/video upload.

## Design notes

- ALL upload steps run in-page (CA-proof) — the ic3 token is session/CA-bound like the skypetoken.
- No new ADR (within ADR-0018).

## Definition of Done

- [ ] Layer 1 green; Layer 2 live-verified (self-note, cleaned); Layer 3 shots.
- [ ] `pnpm check`(touched)/`typecheck`/`test`/`node --check web/server.mjs`/chat build clean.
- [ ] CLAUDE.md updated (the AMS upload recipe: ic3 token + x-ms-migration/x-ms-client-version headers,
      asyncgw host, create→PUT imgpsh→send). No AI attribution.
- [ ] Task → done, `t123` in commit.

## Notes

- ⚠️ Send testing ONLY on `48:notes`; delete test messages. Worktree: docs on `main`, code on feature
  branch; `--no-verify`; never `git add -A`. Recipe proven in scratchpad verify-upload.mjs.
