# 182 — carry mentions and quotes through attachment sends

- **Status:** done
- **Mode:** AFK
- **Estimate:** 0.5d
- **Depends on:** none
- **Blocks:** none

## Goal

@mentioning someone (or quoting a message) while attaching a file currently sends the attachment and silently drops the mention and the quote. Nobody is notified, no reply chain is formed, and the sender gets no indication anything was lost. After this task, an attachment send carries exactly the same mention and quote payload a text-only send does.

## Why now

Silent data loss on a routine action. The send *looks* successful — the message arrives, the file is there — so the failure is invisible until someone asks why they were never pinged. This is the same class of bug as PSN-121 (one image arrived, the rest vanished into a `console.warn`).

## Acceptance criteria

- [x] A send with one image + an @mention delivers a real mention (fans into the recipient's activity feed, not just per-token spans in the body)
- [x] A send with multiple images + an @mention delivers one mention, on the first message of the chain only
- [x] A send with a non-image file + an @mention delivers a real mention
- [x] A quoted reply that also carries an attachment forms a native Teams reply (`qtdMsgs`), not a bare blockquote
- [x] A mention entry lacking an `mri` is dropped rather than sent (it would notify nobody while appearing to work)
- [x] Caption HTML reaches the wire verbatim so per-token mention spans survive; a plain-text caption is still escaped
- [x] Sending an attachment with neither mention nor quote produces byte-identical wire content to before this task

## Test plan

### Layer 1 — Pure logic (TDD)

- [x] `buildSendProperties` — quotes produce `qtdMsgs` + `formatVariant` + `hasValidMsgReferences`
- [x] `buildSendProperties` — mentions serialize as a JSON **string** carrying all five load-bearing fields
- [x] `buildSendProperties` — an entry with no `mri` is dropped; an all-unusable list omits the key entirely
- [x] `buildSendProperties` — quotes and mentions merge; `extra` (the file chip payload) passes through
- [x] `buildSendProperties` — empty input yields `{}` (an attachment send with nothing extra is unchanged)
- [x] `captionHtml` — pre-built HTML wins verbatim; blank HTML falls back to escaped text
- [x] `captionPrefix` (teams-ams) — same split for the AMS image body builders

### Layer 2 — Manual smoke (CDP/IPC)

Self-chat only (issue constraint — no mutations on other users' threads):

- [x] Attachment + mention arrives with the mention registered
- [x] Attachment + quote arrives as a native reply
- [x] Plain attachment, no caption — unchanged

### Layer 3 — Visual review

- [x] Mention pill renders in the caption above the attachment, not raw markup

## Design notes

The wire payload for quotes and mentions was built inline inside the text-reply sender, so the three upload senders had no way to produce it. Extracting it makes the capability shared rather than duplicated.

- **Contracts changed:**
  - `ChatProvider.uploadImage/uploadImages/uploadFile` — third parameter `text?: string` → `opts?: UploadOpts`
  - New `UploadOpts` — `{ text?, html?, quotes?, mentions? }`, mirroring the reply path's `opts`
  - `buildAmsImageContent` — accepts `captionHtml` alongside `caption`
  - `buildAmsImageContentMulti` — third parameter `captionHtml`
- **New modules:** `core/teams-send-props.js` — the one pure builder every Teams send path shares. Justified by four call sites that were previously one-and-three-copies-of-nothing.
- **New ADR needed?** no — this restores intended behavior rather than deciding anything new.

Three separate layers each independently dropped the payload, which is why the bug survived: the FE zeroed mentions before the call, the client/provider signatures had nowhere to put them, and the backend senders passed an empty `properties`. Fixing any one layer alone would have changed nothing observable.

```ts
// the shared shape, threaded end to end
interface UploadOpts {
  text?: string
  html?: string | null   // sent VERBATIM — the only way mention spans survive
  quotes?: ReplyRef[]
  mentions?: MentionRef[]
}
```

## Out of scope

- Backfilling already-sent messages that lost their mentions — unrecoverable, the wire payload was never stored
- Mentions in edits (the edit path takes plain text and has no mention affordance)
- Channel mentions / tag mentions — this surface lists chats only

## Definition of Done

- [x] Layer 1 tests written and green
- [x] Layer 2 smoke checklist completed
- [x] `pnpm check` clean
- [x] `pnpm typecheck` clean
- [x] `pnpm test` green
- [x] No commented-out code, no `console.log` debris, no AI attribution
- [x] Task closed: status → done, file moved to `docs/tasks/done/`, t182 in commit

## Notes

The mention wire shape is unforgiving and was learned the hard way (PSN-120): an entry missing `@type` or `mentionType`, or carrying a bare oid instead of the full `8:orgid:{oid}` MRI, is accepted with a 201 and mentions nobody. `buildSendProperties` is now the single place that shape is written, so there is one thing to get right instead of four.

Dropping an mri-less entry rather than forwarding it is a deliberate choice: a mention that silently notifies nobody is worse than no mention, because the sender believes it worked.
