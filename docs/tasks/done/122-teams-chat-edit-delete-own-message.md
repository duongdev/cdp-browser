# 122 — teams chat: edit + delete own message

- **Status:** done
- **Mode:** HITL
- **Depends on:** t108 (reply/write pattern), t113 (merge/optimistic)

## Goal

The user can edit and delete their own messages, optimistically, live-synced. Read-side "(edited)"
and the deleted tombstone already render (t107) — this adds the write + the UI affordance.

## PROVEN endpoints (live 2026-07-22, self-note, cleaned up)

- **EDIT**: `PUT {chatServiceBase}/v1/users/ME/conversations/{convId}/messages/{msgId}` body
  `{"content":"<p>…</p>","messagetype":"RichText/Html","contenttype":"text"}` → **200**; sets
  `properties.edittime` (→ the existing `edited` flag).
- **DELETE**: `DELETE {chatServiceBase}/v1/users/ME/conversations/{convId}/messages/{msgId}` → **200**;
  sets `properties.deletetime` + blanks content (→ the existing `deleted` tombstone). The message row
  survives (status 200) as a tombstone.
- Both run IN-PAGE (CA-proof) — mirror `teamsReply` / the react endpoint cred flow verbatim.

## Scope

### Server
- **`web/server.mjs`**: `POST /api/teams/edit` `{ convId, msgId, text }` → in-page PUT (wrap `text` in
  `<p>…</p>`, HTML-escaping the text like a plain compose — reuse whatever escaping the reply path uses,
  or `escapeHtml`); `POST /api/teams/delete` `{ convId, msgId }` → in-page DELETE. Best-effort `{ ok }`;
  401 → one re-authz+retry then typed error. Register beside the other `/api/teams/*` routes.

### Client
- **`chat/src/lib/teams-client.ts`**: `editMessage(convId, msgId, text)` + `deleteMessage(convId, msgId)`
  (POST; throw `TeamsApiError` on failure so the UI can keep the draft / show a message, like `sendReply`).
- **`chat/src/components/message-row.tsx`** + **`chat/src/components/thread-view.tsx`**: on the user's
  OWN messages (`message.self`), a hover/tap **action menu** (⋯ or inline Edit/Delete buttons; reuse the
  same reveal pattern as the reaction quick-bar):
  - **Edit** → inline edit: replace the bubble body with an auto-grow `<textarea>` seeded with the
    message's current text (strip HTML → plain text for editing), Save (Enter / a button) / Cancel (Esc).
    On save: optimistically update the message body + set `edited:true` locally, call `editMessage`, let
    the poll reconcile; on failure keep the editor open with the text + an honest error.
  - **Delete** → a small confirm (a shadcn `AlertDialog` if present, else an inline "Delete?" confirm —
    NOT `window.confirm`, it's blocked in automation). On confirm: optimistically tombstone the message
    (body "message deleted", `deleted:true`), call `deleteMessage`, poll reconciles.
  - Thread-view owns message state, so pass `onEdit(msgId, text)` / `onDelete(msgId)` callbacks down that
    do the optimistic `setState` + the client call (same shape as the t121 `onReact` wiring). Reuse the
    pending-overlay idea only if needed — a straight optimistic setState + the server-wins merge is fine
    here because an edit/delete makes the body DIFFER, and once the server reflects it the merge is a
    no-op (unlike reactions, the server propagates edits/deletes into the message body the poll fetches).
- A deleted (tombstone) or others' message shows no edit/delete affordance. An already-`deleted` message
  isn't editable.

## Acceptance criteria

- [ ] Editing an own message updates it + shows "(edited)"; live-verified on the self-note.
- [ ] Deleting an own message replaces it with the tombstone; verified on the self-note (create → edit →
      delete a throwaway message, all cleaned up).
- [ ] Edit/delete affordances appear ONLY on own, non-deleted messages.
- [ ] A failed edit keeps the editor + text; a failed delete leaves the message.

## Test plan

- **Layer 1 (TDD)**: any pure helper (e.g. HTML→plain-text seed for the editor, or an optimistic
  edit/delete reducer if you extract one). If it's all effectful glue, note "n/a — CDP/IPC + UI".
- **Layer 2 (live, orchestrator)**: create a self-note test message → edit → delete → confirm each via a
  re-fetch; clean up.
- **Layer 3 (visual)**: own message shows the menu; edit-in-place; tombstone after delete.

## Design notes

- Read-side edited/deleted already handled (`toReaderMessages`: `edited` from `edittime`, `deleted`
  from `deletetime`/`systemdelete`). No render change needed there.
- No new ADR.

## Out of scope

- Edit history / "edited at". Rich-text editing (plain text only, matching the composer). Undo delete.

## Definition of Done

- [ ] Layer 1 (if any) green; Layer 2 live-verified (self-note, cleaned); Layer 3 shots.
- [ ] `pnpm check`(touched)/`typecheck`/`test`/`node --check web/server.mjs`/chat build clean.
- [ ] CLAUDE.md updated (edit PUT / delete DELETE endpoints + own-message menu). No AI attribution.
- [ ] Task → done, `t122` in commit.

## Notes

- ⚠️ Edit/delete testing ONLY on `48:notes` (create throwaway messages); clean up. Worktree: docs on
  `main`, code on feature branch; `--no-verify`; never `git add -A`.
