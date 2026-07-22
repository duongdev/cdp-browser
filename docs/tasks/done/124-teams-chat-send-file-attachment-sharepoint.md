# 124 — teams chat: send a file attachment (non-image) via SharePoint/OneDrive upload

- **Status:** done
- **Mode:** HITL
- **Depends on:** t108 (send), t119 (file-attachment READ/chips), t123 (send-image / upload plumbing)

## Goal

Attach and send an arbitrary file (PDF, doc, screenshot-as-file, etc.) in the composer. Unlike an
inline image (AMS, t123), a **file** uploads to the user's **OneDrive/SharePoint** "Microsoft Teams
Chat Files" folder and is posted as a file chiclet — the same `properties.files` shape t119 already
RENDERS (chip → SharePoint `shareUrl`). This is the SEND side.

## PROVEN recipe (verified live 2026-07-22, self-note `48:notes`, upload→share→send→render→open→delete)

The verification probe round-tripped end-to-end (a `.pdf` with a spaces+parens filename): upload 201,
createLink 201, send 201, t119 render + open confirmed, cleanup delMsg 200 / delFile 204. No
user-assisted capture was needed; the driveItem + a createLink are enough. All steps run IN-PAGE
(CA-proof), like t123's image upload. No `addStub` / `StartUpload` / `driveItem/commands` — those in the
old capture were Teams' large-file/preview extras; a small simple upload skips them.

Auth/discovery (page MSAL localStorage + one authz):
- **SP bearer** = the MSAL accesstoken whose `target` matches `*-my.sharepoint.com`
  (`https?://([a-z0-9-]+-my\.sharepoint\.com)`); capture that host as `myHost`. (Aud is the SharePoint
  Online resource `00000003-0000-0ff1-ce00-000000000000`.)
- **skypetoken + chatServiceBase** = the existing cred path (authz).
- **`{userPath}`** = `GET https://{myHost}/_api/v2.0/me/drive` (Bearer sp) → `webUrl` contains
  `/personal/{userPath}/Documents`; extract via `/\/personal\/([^/]+)\//`.

Upload + share (SharePoint; headers `Authorization: Bearer {sp}` + `scenario: ShareUploadFile` +
`scenariotype: AUO`):
1. `PUT https://{myHost}/_api/v2.0/drive/root:/Microsoft Teams Chat Files/{encodeURIComponent(filename)}:/content`
   (`Content-Type: application/octet-stream`, body = raw bytes) → **201** driveItem `D` (`id`, `name`,
   `webUrl`, `eTag`, `file`; note the v2.0 upload response usually OMITS `sharepointIds`, so `D.id` is the
   unique-id fallback).
2. `POST https://{myHost}/_api/v2.0/drive/items/{D.id}/createLink` (`Content-Type: application/json`,
   body `{"type":"view","scope":"organization"}`) → **201** `{link:{webUrl}}` = the browser-openable
   `shareUrl` (a `/:t:/g/…` or `/:b:/g/…` link).
3. Send: `POST {chatServiceBase}/v1/users/ME/conversations/{convId}/messages` with `messagetype:"RichText/Html"`,
   empty `content` (or an escaped-HTML caption), and `properties.files: JSON.stringify([fileObj])` → **201**.

`fileObj` is built FRESH from inputs by `core/teams-files.js:buildTeamsFilePayload` (do NOT depend on a
pre-existing "golden" message — a fresh chat has none). Its fields (`@type` = `http://schema.skype.com/File`,
`itemid`/`id` = `D.sharepointIds?.listItemUniqueId || D.id`, `fileType`/`type` = ext, `objectUrl`/`baseUrl`
percent-encoded, `fileInfo.serverRelativeUrl` RAW, `fileInfo.shareUrl` = the createLink url,
`fileChicletState:{serviceName:"p2p",state:"active"}`) are exactly what t119's `parseFiles` reads back.

⚠️ **Gotcha (cost a false first pass):** the web try-server must be RESTARTED after adding the route —
a stale `node web/server.mjs` process 404s `/api/teams/upload-file` and the composer shows
"Could not send". The client build (`dist-chat`) is picked up live, the server process is not.

## Scope (after the probe proves the flow)

### Server
- **`web/server.mjs` `POST /api/teams/upload-file`** `{ convId, filename, base64, contentType, text? }` →
  IN-PAGE (CA-proof): read the SP bearer from MSAL + skypetoken → discover `{userPath}` (cache it per
  session) → upload (simple PUT, or StartUpload for large) → create sharing link → **send** the message
  with `properties.files` referencing it (+ optional caption). Return `{ ok, msgId }` / typed error.
  Size limit like t123's `IMAGE_BODY_LIMIT` (files can be large — consider a higher cap + a client guard;
  for v1 cap at a sane size, e.g. 24–50MB, and reject bigger with an honest error).

### Client
- **`chat/src/components/thread-view.tsx`** composer: extend the t123 pending-attachment slot to accept
  ANY file (a file-pick button `<input type=file>` + drop/paste of non-image files) → a **file chip**
  (name + type icon, not a thumbnail) → Send uploads via `/api/teams/upload-file` → optimistic file chip
  → poll reconciles to the server `properties.files` chip (t119). Reuse the pending-attachment plumbing
  from t123 (generalize "pending image" → "pending attachment" = image | file).
- **`chat/src/lib/teams-client.ts`**: `uploadFile(convId, file, text?)`.

## Acceptance criteria

- [x] Attaching a file (e.g. a PDF) and sending it posts a file chiclet that renders (t119 chip) and
      opens the SharePoint file. Verified live on the self-note (upload → chip → open → delete, cleaned)
      AND via the real UI send (composer stage → Send → reconciled chip), all artifacts deleted.
- [x] Large file: rejected with an honest "too large" message above the `FILE_BODY_LIMIT` (40 MB base64);
      resumable large-file upload deferred (out of scope).
- [x] Image paste (t123) still works; the pending slot cleanly handles image vs file (`pendingFile`).

## Test plan

- **Layer 1 (TDD)**: pure helpers — the `properties.files` builder (from driveItem + shareUrl + filename),
  the `{userPath}`/URL builders, the file-type→icon mapping (may already exist from t119).
- **Layer 2 (live, orchestrator)**: the verification probe round-trip on the self-note; then the wired
  endpoint. Clean up uploaded test files + messages.
- **Layer 3 (visual)**: pending file chip in the composer; sent file chiclet in the thread.

## Out of scope / follow-ups

- Multiple files per message; drag-drop of many files; upload progress bars; video upload; large-file
  chunking if deferred to v2 (reject-oversize is acceptable for v1).

## Design notes

- ALL steps in-page (CA-proof) — the SP token is session/CA-bound like the others.
- Reuses t119's file-chip RENDER (this is the SEND half). No new ADR (within ADR-0018).
- The AMS image path (t123) and this SharePoint file path are DISTINCT — Teams itself ran both when the
  captured image was sent (inline AMS + a SharePoint file copy). For a plain non-image file, only the
  SharePoint path applies.

## Definition of Done

- [x] Verification probe round-trips (upload→share→send→render→open→delete). Layer 1 green (12 pure
      `teams-files` tests), Layer 2 live (probe + real UI send, cleaned), Layer 3 shots (pending chip +
      sent chip).
- [x] `typecheck`/`test` (1319 pass)/`node --check web/server.mjs`/chat build clean.
- [x] Recipe documented in this task + the `teams-chat-app-epic` memory (the epic's home; CLAUDE.md holds
      no Teams-app content — nothing to add there). No AI attribution.
- [x] Task → done, `t124` in commit.

## Outcome (built)

- **`core/teams-files.js`** (+ 12 tests) — pure `buildTeamsFilePayload` / `fileExt`.
- **`web/server.mjs`** — `sendTeamsMessageInPage` gains a `properties` arg; `uploadTeamsFileInPage`
  (in-page SP upload + createLink) + `teamsUploadFile` + `FILE_BODY_LIMIT` (40 MB) + `POST /api/teams/upload-file`.
- **`chat/src/lib/teams-client.ts`** — `uploadFile(convId, file, text?)`.
- **`chat/src/lib/image-attach.ts`** — `pickImageFile` generalized → `pickFile` (any MIME).
- **`chat/src/components/thread-view.tsx`** — `pendingImage` → `pendingFile` (image thumbnail | file chip);
  send routes image→`uploadImage`, file→`uploadFile`; optimistic file echo. `message-row.tsx` untouched
  (its t119 `AttachmentChip` already renders the optimistic file chip).

## Notes

- ⚠️ Upload/send testing ONLY on `48:notes`; delete test messages AND uploaded test files. Worktree:
  docs on `main`, code on feature branch; `--no-verify`; never `git add -A`.
- Capture evidence: `scratchpad/capture-result.json` (the real upload — AMS + SharePoint requests). The
  proven AMS image recipe is in `scratchpad/verify-upload.mjs` (reuse its cred-extraction pattern).
