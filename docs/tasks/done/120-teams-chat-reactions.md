# 120 — teams chat reactions: display + add/remove (quick-react bar)

- **Status:** done
- **Mode:** HITL
- **Depends on:** t108 (reply/mark-read write pattern), t113 (live-sync merge)

## Goal

Reactions render on messages, and the user can add/remove a reaction. Teams' default reaction set,
optimistic + live-synced.

## PROVEN endpoints + shape (live probes 2026-07-22 — use verbatim)

- **READ**: `message.properties.emotions` = `[{ key: "<emotionKey>", users: [{ mri, time, value }] }]`
  (may arrive as a JSON **string** — parse defensively, like `properties.mentions`/`files`). Keys are
  **named**, not raw emoji: the 6 defaults `like`/`heart`/`laugh`/`surprised`/`sad`/`angry`, plus an
  extended set (`loudlycrying`, `man_gesturing_not_ok`, …). A key with `users: []` = nobody reacts (hide).
- **ADD**: `PUT {chatServiceBase}/v1/users/ME/conversations/{convId}/messages/{msgId}/properties?name=emotions`
  body `{"emotions":{"key":"<key>","value":<Date.now()>}}` → **200** (verified: adds the self mri).
- **REMOVE**: `DELETE` the SAME url, body `{"emotions":{"key":"<key>","value":<ms>}}` → **200** (verified:
  removes the self mri; the key row stays with `users: []`). Both run IN-PAGE (CA-proof, like reply/mark-read).
- Self identity for "did I react" = the account oid (`accounts.user_id`), matched against `users[].mri`.

## Scope

### Read + parse
- **`core/teams-emoji.js`** (pure, TDD): `reactionEmoji(key)` — map the well-known Teams emotion keys →
  a display emoji (6 defaults + the common extended ones seen); unknown key → a neutral fallback (e.g.
  the key isn't shown raw — use a generic 🙂 or keep a small map + `"❓"`). Keep it a simple table.
- **`core/teams-render.js`** (`toReaderMessages`): parse `properties.emotions` (defensive string/array)
  → `reactions: [{ key, emoji, count, mine }]` on the ReaderMessage (count = users.length, `mine` =
  self oid ∈ users' mris; drop keys with 0 users). selfId already available.

### Write
- **`web/server.mjs` `POST /api/teams/react`** `{ convId, msgId, key, remove?: boolean }` → in-page
  `PUT` (add) or `DELETE` (remove) the emotions property with the proven body; mirror `teamsReply`/
  `mark-read` cred flow (fresh cred → in-page → one re-authz+retry on 401). Return `{ ok }` best-effort.

### Client
- **`chat/src/lib/teams-client.ts`** — `TeamsMessage.reactions?: {key,emoji,count,mine}[]`; `react(convId,
  msgId, key, remove)` → POST `/api/teams/react`.
- **`chat/src/components/message-row.tsx`** — render **reaction chips** below the body (emoji + count;
  the chip is highlighted/accented when `mine`; click a chip toggles the self reaction for that key). A
  **quick-react bar** appears on hover (fine pointer) / long-press or a small "＋" affordance (touch): the
  6 default emojis (👍❤️😆😮😢😠 → like/heart/laugh/surprised/sad/angry) — tap adds that reaction.
  Optimistic: update the message's `reactions` locally on click (add/remove self, adjust count), then the
  server call + the next poll reconcile.
- **`chat/src/lib/message-merge.ts`** — include `reactions` in the `changed` comparison so a poll that
  brings new/removed reactions re-renders (today it only checks id/body/edited/deleted/ts). Keep the
  same-ref no-op when nothing (incl. reactions) changed.

## Acceptance criteria

- [ ] A message with reactions shows chips (emoji + count); my own reaction is visibly highlighted.
- [ ] Clicking the quick-react bar adds that reaction (optimistic, then confirmed); clicking my existing
      reaction chip removes it. Verified live on the self-note (`48:notes`) — add then remove, cleaned up.
- [ ] A reaction added elsewhere appears within a poll cycle (merge detects the change).
- [ ] `properties.emotions` as a JSON string parses correctly (no silent no-op — the t118 mention trap).

## Test plan

- **Layer 1 (TDD)**: `reactionEmoji` (known keys, fallback); emotions parse in `toReaderMessages`
  (string + array shape, count, `mine` true/false, 0-user key dropped); `mergeMessages` reaction-change
  detection (a message whose reactions changed → `changed: true`; unchanged → same ref).
- **Layer 2 (live, orchestrator)**: add/remove a reaction on the self-note via the app → 200 + it
  appears/disappears; a message with existing reactions renders chips. Clean up test reactions.
- **Layer 3 (visual)**: chips + quick-react bar; mine highlighted.

## Design notes

- **New modules**: `core/teams-emoji.js`. No new ADR.
- Reaction picker = the **fixed 6 Teams defaults** (not an arbitrary-emoji picker) — a simple inline
  emoji-button bar, NOT `frimousse` (that's for free-emoji; Teams reactions are a closed set). `ponytail:`
  extended-set picker deferred.
- Emotion `value` in the body is a client timestamp (`Date.now()`); Teams echoes it back on read.

## Out of scope

- The full extended reaction set in the picker (6 defaults only). Per-reactor tooltips (who reacted).
- Reaction animations.

## Definition of Done

- [ ] Layer 1 green. Layer 2 live-verified (self-note add/remove, cleaned). Layer 3 shots.
- [ ] `pnpm check`(touched)/`typecheck`/`test`/`node --check web/server.mjs`/chat build clean.
- [ ] CLAUDE.md updated (reactions: read `properties.emotions`, PUT/DELETE emotions endpoint, quick-react
      bar). No AI attribution.
- [ ] Task → done, `t120` in commit.

## Notes

- ⚠️ Send/react testing ONLY on the self-chat `48:notes`, and REMOVE test reactions after. Worktree:
  docs on `main`, code on feature branch; `--no-verify`; never `git add -A`.
