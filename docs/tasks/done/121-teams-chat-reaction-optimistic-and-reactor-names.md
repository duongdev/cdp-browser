# 121 — teams chat reactions: optimistic that sticks + who-reacted on hover

- **Status:** done
- **Mode:** HITL
- **Depends on:** t120 (reactions)

## Goal

Two user-reported gaps on t120:
1. **Optimistic reaction gets clobbered** — clicking a reaction shows it, then it disappears and
   reappears on the next poll. The 4s poll's `mergeMessages` (server-wins) overwrites the optimistic
   reaction with the server's still-stale view (Teams hasn't propagated the reaction yet).
2. **Who reacted** — hovering a reaction chip should show the reactor names.

## Part A — optimistic reactions survive the poll (pending overlay)

The optimistic `setState` in `onReact` is correct, but the poll's `mergeMessages` reverts it because
the server response for that message doesn't yet include the reaction. Add a **pending-reaction
overlay** that is re-applied after every merge until the server confirms.

- `chat/src/components/thread-view.tsx`: a `pendingReactionsRef` = `Map<msgId, Map<key, { emoji,
  desiredMine, ts }>>`. On `onReact(msgId, key, emoji, remove)`: set `pending[msgId][key] = { emoji,
  desiredMine: !remove, ts: <mono> }`, apply the optimistic state (as today), fire `react()`.
- A pure helper (in `chat/src/lib/message-merge.ts`, TDD): `applyPendingReactions(messages, pending)`
  → for each message with pending keys, force each key's `mine` to `desiredMine` (add the chip with
  `mine:true` + bump count if desired & absent; set `mine:false` + drop/decrement if not desired). It
  overlays the server state so a stale poll can't revert the user's own just-made change.
- The poll (and older-page merges): after `mergeMessages`, run `applyPendingReactions(merged, pending)`
  before `setState`. Recompute `changed` including the overlay so the same-ref no-op still holds when
  truly nothing changed.
- **Clear a pending entry** when the server catches up: in the poll, BEFORE overlaying, if the incoming
  merged reaction for `(msgId, key)` already has `mine === desiredMine`, delete that pending entry (the
  server confirmed — stop overlaying). Plus a safety timeout: drop any pending entry older than ~20s
  (a lost write shouldn't pin a phantom reaction forever).

## Part B — reactor names on hover

- **`core/teams-render.js` `parseEmotions`**: include the reactor MRIs per reaction (`userMris:
  string[]`, cap ~25) alongside `{key, emoji, count, mine}`.
- **`web/server.mjs` `teamsHistory`**: after `toReaderMessages`, resolve reactor MRIs → display names
  and attach `reactorNames: string[]` per reaction — REUSE the existing name path (`teamsGetUsers`
  cache first, then a single in-page Graph `getByIds` batch for misses, cached to the `users` table —
  exactly like `teamsResolveTitles` does for DM members). Best-effort: unresolved MRIs are omitted from
  `reactorNames` (the chip still shows emoji + count). Drop `userMris` from the client payload (names
  only). Cache-warm so repeat polls don't re-hit Graph.
- **`chat/src/lib/teams-client.ts`**: `TeamsReaction.reactorNames?: string[]`.
- **`chat/src/components/message-row.tsx`**: the reaction chip gets a **hover tooltip** of the reactor
  names — a `title` attr (`"Alice, Bob"`, or `"Alice, Bob and 3 more"` when `count > reactorNames.length`)
  is enough; if the chat app already has a shadcn `Tooltip`, use it, else `title`. "You" for the self
  reactor when `mine` (put "You" first).

## Acceptance criteria

- [ ] Clicking a reaction keeps it visible through the next poll (no disappear/reappear); it's still
      there after the server confirms. Removing (toggling) stays removed. Verified live on the self-note.
- [ ] Hovering a reaction chip shows who reacted (names; "You" when it's yours).
- [ ] A reaction added by someone else still appears within a poll (the overlay never hides real data).

## Test plan

- **Layer 1 (TDD)**: `applyPendingReactions` (adds/keeps a desired-mine reaction over a server list that
  lacks it; removes a not-desired one the server still shows; leaves other messages/keys untouched;
  no-op when server already matches). `parseEmotions` carries `userMris` (cap). 
- **Layer 2 (live, orchestrator)**: self-note — react, watch it survive ≥2 poll cycles, then remove;
  a message with existing reactions shows names on hover. Clean up test reactions.

## Design notes

- The overlay is keyed by (msgId, key) and self-heals: it stops the moment the server reflects the
  desired state, so it can't mask a later real change. The ~20s timeout guards a failed write.
- Resolving reactor names reuses the t109 users cache + Graph batch — no new resolution path. Keep it
  cache-first so the 4s poll doesn't add Graph latency once warm.
- No new ADR.

## Out of scope

- A rich reactor popover (avatars, per-emoji breakdown) — `title` tooltip is enough. Reaction
  animations.

## Definition of Done

- [ ] Layer 1 green. Layer 2 live-verified (optimistic survives + names on hover), test reactions cleaned.
- [ ] `pnpm check`(touched)/`typecheck`/`test`/`node --check web/server.mjs`/chat build clean.
- [ ] CLAUDE.md updated (optimistic overlay + reactor-name tooltip). No AI attribution.
- [ ] Task → done, `t121` in commit.

## Notes

- ⚠️ React testing ONLY on the self-chat `48:notes`; remove test reactions after. Worktree: docs on
  `main`, code on feature branch; `--no-verify`; never `git add -A`.
