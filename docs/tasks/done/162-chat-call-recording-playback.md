# t162 — Call recording playback (link-out to SharePoint)

Status: done
Depends on: t141 (recording chip)
Scope: `core/teams-render.js` + `chat/src/components/message-row.tsx`.
Plan: PSN-90 Phase 2, workstream O (item 9).

## Live probe (Trainer Squad Standup, read-only side-channel)

Dumped the real `RichText/Media_CallRecording` payloads. Findings:

- A meeting emits **several chunk rows** — `RecordingStatus` `Initial` → `ChunkFinished` (one per
  content type) → the finished master `Success`. Only the master is playable; the chunks carry
  empty hrefs.
- The playback URL is **SharePoint/OneDrive**, not AMS: a `<a href="https://…sharepoint.com/:v:/…">Play</a>`
  anchor plus an `<item type="onedriveForBusinessVideo" uri="…sharepoint…">`. `RecordingStorage`
  is `MeetingOrganizerOneDrive`.
- An `amsVideo` uri exists too, but the recording is 43 min — streaming it through the buffering
  `/api/teams/media` proxy (whole blob → data URL → bytes, LRU) is a memory bomb. **Link-out is the
  correct path** (browser SSO, like a file chip); inline AMS playback rejected.

## What shipped

- `parseUriObjects` (`teams-render.js`): a recording attachment now carries `title` +
  `url` (the SharePoint playback link — anchor href, falling back to the
  `onedriveForBusinessVideo` item uri). In-progress chunks (`Initial`/`ChunkFinished`) are
  **dropped** so a thread shows ONE recording chip, not four dead ones; a recording message that
  yields no chip is skipped in `toReaderMessages`.
- `message-row.tsx`: the recording chip is a **link-out** (`<a target=_blank>`) when it has a url —
  thumbnail with a play overlay + title + "Play recording"; a url-less recording stays a passive
  chip. The dead `<span>` is gone.
- TDD: url/title extraction, onedrive-item fallback, chunk-drop, and the toReaderMessages
  skip-chunks-keep-master case.

## Verification

- `vitest run core chat/src/lib` — 285 pass. `tsc --noEmit` + biome clean.
- Probe script (throwaway) under `.scratch/`, not committed.
