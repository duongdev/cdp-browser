# 115 — teams chat: Teams-accurate group naming (given names) + show the self "Notes" chat

- **Status:** done
- **Mode:** HITL
- **Depends on:** t109 (name resolution)

## Goal

Make the conversation-list / thread titles match real Teams as closely as possible, and stop
hiding the self "Notes" chat. Two user asks:
1. **Don't filter the self message** — the self-chat (`48:notes`, Teams' "Notes"/"chat with
   yourself") is currently dropped by the reserved filter; show it, titled like Teams does.
2. **Group-DM naming** — Teams composes a topic-less group chat from **given (first) names**, not
   full display names, with a specific join style + overflow. Match it.

## PROVEN Teams rules (inspected live over CDP on the running tenant — use verbatim)

Real Teams left-rail titles (`role="treeitem"` text / `graph /me`):
- **Self-chat** row = `Dustin Do - Group Office [C] (You)` → title = `{selfDisplayName} (You)`. The
  self-chat id is **`48:notes`** (the raw conversations API returns `48:notes`, `48:notifications`,
  `48:mentions`; only `48:notes` is a real chat — it has a `lastMessage`). There is NO `19:self_self`
  one-on-one.
- **1:1 DM** = the other person's **full** display name (e.g. `Haiyang Zhao - Group Office`). Unchanged.
- **Group DM, no topic** = **given names** (first whitespace token of each member's display name;
  Graph `givenName` — e.g. `Careen Tan - Group Office` → `Careen`), self excluded, sorted alpha,
  joined Teams-style by member count `n` (n = others, self already excluded):
  - `n == 2` → `A and B`            (observed: `Careen and Tiffani`)
  - `n == 3` → `A, B, and C`        (observed: `Careen, Glory, and Haiyang` — Oxford comma + "and")
  - `n >= 4` → `A, B, +{n-2}`       (observed: `Careen, Haiyang, +2` — first 2 given names + overflow)
- **Group with topic** = the topic verbatim. Unchanged.
- Self identity for the tenant: `displayName "Dustin Do - Group Office [C]"`, `givenName "Dustin"`,
  oid `623d9d09-…` (= `cred.userId`; selfMri = `8:orgid:{cred.userId}`).

## Acceptance criteria

- [ ] The `48:notes` self-chat appears in the conversation list, titled `{selfName} (You)` (exactly
      as Teams shows it). `48:notifications` / `48:mentions` stay hidden.
- [ ] Opening the self-chat loads its history + the composer works (it's the send-test sandbox).
- [ ] A topic-less group DM shows **given names** joined by the Teams rules above (2 → "A and B",
      3 → "A, B, and C", 4+ → "A, B, +N"), sorted alpha, self excluded. Verified against the real
      Teams left-rail strings for the same chats.
- [ ] 1:1 DMs and topic groups are unchanged (full name / topic).

## Test plan

### Layer 1 — Pure logic (TDD, `core/teams-names.js`)

- [ ] `composeTitle` group given-name join: n=2 "A and B"; n=3 "A, B, and C" (Oxford + and);
      n=4 "A, B, +2"; n=5 "A, B, +3"; alpha sort; duplicate given names kept (two different people);
      given name = first token of `"First Last - Group Office"`.
- [ ] `composeTitle` kind `"self"` → `"{selfName} (You)"`; empty selfName → `"Notes"` fallback.
- [ ] 1:1 unchanged (full other name); topic wins for any kind; empty → "Direct message"/"Group chat".
- [ ] `conversationKind("48:notes")` → `"self"`; `isReservedConversation`: `48:notifications` /
      `48:mentions` still reserved, `48:notes` NOT reserved.

### Layer 2 — Manual smoke (live keeper, orchestrator-run)

- [ ] `48:notes` in the list titled "Dustin Do - Group Office [C] (You)"; open + send a self-message
      (authorized self-chat), then delete it.
- [ ] Two or three group DMs match the real Teams left-rail names exactly (given-name form).

### Layer 3 — Visual review

- [ ] List shows the self-chat + given-name group labels; screenshot vs the real Teams rail.

## Design notes

- **Contracts changed:** `TeamsConversation.kind` gains `"self"` (`"oneOnOne" | "group" | "self"`).
  `composeTitle` input gains the self case (a `kind: "self"` + `selfName`). No API-route/shape change.
- **`core/teams-store.js`**: `isReservedConversation` = `id.startsWith("48:") && id !== "48:notes"`;
  `conversationKind("48:notes") → "self"` (else existing oneOnOne/group logic).
- **`core/teams-names.js`**: given-name derivation (first token) + the count-based Teams join +
  the `"self"` kind. Keep it pure/defensive.
- **`web/server.mjs` `teamsResolveTitles`**: for a `"self"` conv, title = `{selfName} (You)`;
  resolve `selfName` robustly — `cred.displayName` OR the Graph-resolved `selfMri` (add `selfMri`
  to the batch when a self conv is present) OR "Notes". Groups already pass member display names;
  `composeTitle` extracts given names from them (no extra Graph field needed).
- **`chat/src/lib/teams-client.ts`**: widen the `kind` union to include `"self"`.
- **`chat/src/lib/conversation-view.ts`**: `conversationLabel` — kind `"self"` fallback → "Notes"
  (title from the server normally wins).
- **New ADR needed?** No — within ADR-0018.

## Out of scope

- A "Notes" pin / special placement / self-chat icon (Teams pins it top; we just list it by ts).
- Given-name via the Graph `givenName` field (first-token of displayName matches this tenant; revisit
  only if a display name's first token isn't the given name).
- The list-preview markup leak (`&nbsp;`/mention spans) — that's the UI-polish task.

## Definition of Done

- [ ] Layer 1 green (given-name join cases + self kind + store kind/reserved changes).
- [ ] Layer 2 live-verified by the orchestrator against the real Teams rail.
- [ ] Layer 3 shot.
- [ ] `pnpm check`(touched)/`typecheck`/`test`/chat build clean.
- [ ] CLAUDE.md updated (Teams naming: given-name group rule + self-notes chat). No AI attribution.
- [ ] Task → done, moved to `done/`, `t115` in commit.

## Notes

- Worktree: docs on `main`, code on feature branch `Native-Teams-chat-UI` (2-commit ship); never
  `git add -A`; `--no-verify` (rtk breaks pre-commit). Rules PROVEN live 2026-07-21 via CDP DOM +
  graph `/me` probe — the join style + overflow are copied from the actual Teams rail, not guessed.
