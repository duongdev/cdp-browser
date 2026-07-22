# 141 — teams chat attachments: file chips + call-recording / card chips (no garbled URIObject text)

- **Status:** done
- **Mode:** HITL
- **Depends on:** t133 (render), t139 (media proxy)

## Goal

Surface the message attachments the plain body couldn't render:
- **File uploads** were invisible (`properties.files` dropped) → render a chip that opens the file.
- **Call-recordings + Swift cards** rendered as garbled `<URIObject>` inner text → render a clean chip.

## PROVEN shapes (live probes)

- `properties.files` is a **JSON STRING** (like `properties.mentions` — parse defensively) → array of
  `{ fileName, fileType, objectUrl, fileInfo:{ shareUrl, fileUrl } }`. Best open URL =
  `fileInfo.shareUrl` → `objectUrl` → `fileInfo.fileUrl` (SharePoint — browser SSO opens it, NO proxy).
- Call-recording = `<URIObject type="Video…/CallRecording…" url_thumbnail="{AMS url}">…</URIObject>`;
  Swift card = `<URIObject type="SWIFT…" url_thumbnail="{url}"><Title>Card</Title>…</URIObject>`. Both
  live in `content`; their messagetypes (`RichText/Media_CallRecording`, `RichText/Media_Card`) are
  NOT "html", so the body's escape branch leaked the raw `<URIObject …>` as text.

## What shipped

- **`core/teams-render.js`** — `parseAttachments(message)` → flat `{ kind:"file"|"recording"|"card",
  name?, type?, url?, thumbnailUrl?, title? }[]`: files from the JSON-string `properties.files`;
  recording/card from `<URIObject>` blocks (thumbnails routed through the media proxy via
  `isValidAmsUrl` when AMS, else left direct). `renderBody` **strips `<URIObject>` blocks first**
  (before the messagetype branch) so they never leak — the chip carries the meaning. `toReaderMessages`
  attaches the parsed list to each ReaderMessage (omitted when empty / on tombstones).
- **`chat/src/lib/teams-client.ts`** — `TeamsAttachment` + optional `attachments` on `TeamsMessage`.
- **`chat/src/components/message-row.tsx`** — renders file / recording / card chips below the body
  (file → an `<a target=_blank>` to the SharePoint link with a type icon; recording → proxied
  thumbnail + "Call recording"; card → title + thumbnail). A message with only attachments shows no
  bubble, just chips.
- No `web/server.mjs` change — `teamsHistory` returns freshly-rendered `toReaderMessages`, so the new
  field rides through.

## Acceptance criteria

- [x] A file message shows a chip with the filename that opens the SharePoint link. (Live: 2 chips in
      "Agent Guru <> Cube Integration", both → fwdgroup-my.sharepoint.com.)
- [x] Call-recording / card messages render a clean chip, NOT garbled `<URIObject>` text. (Live: 56
      card/recording messages, 0 leaked/duplicate bodies.)

## Test plan

- **Layer 1 (TDD)**: `parseAttachments` — JSON-string files, shareUrl→objectUrl→fileUrl fallback,
  empty/malformed→none, recording thumbnail proxied, swift-card title+thumbnail, non-AMS thumbnail raw,
  URIObject-only body → empty (no leak), text-kept-block-stripped. (43 tests in teams-render.test.ts.)
- **Layer 2/3 (live)**: file chips open SharePoint; no URIObject/`[card]` junk anywhere — verified.

## Out of scope

- Full adaptive-card (`properties.cards`) rendering via `adaptivecards` — the chip is a placeholder.
- Inline recording playback. `ThreadActivity/*` system messages (still skipped — not junk).

## Definition of Done

- [x] Layer 1 green (1259 tests). typecheck / biome (touched) / chat build / `node --check` clean.
- [x] Live-verified (file chips + no leak). CLAUDE.md updated. No AI attribution.
- [x] Task → done, `t141` in commit.

## Notes

- ⚠️ `properties.*` (mentions/files/cards) are JSON STRINGS — always parse defensively (the t140
  mention bug was exactly this). Worktree: docs on `main`, code on feature branch; `--no-verify`.
