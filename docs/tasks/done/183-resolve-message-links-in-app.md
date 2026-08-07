# 183 — resolve message links inside the app

- **Status:** done
- **Mode:** AFK
- **Estimate:** 0.5d
- **Depends on:** none
- **Blocks:** none

## Goal

A Teams message link pasted into a conversation renders as a plain external anchor: clicking it leaves the app for the Teams web client. After this task, a message link that points at a conversation this app can reach opens *in place* — the thread switches if needed, scrolls to the message, and highlights it — using the jump machinery already built for citations and reply quotes.

## Why now

Message links are how people hand each other context. Following one currently means losing your place: a new tab, a second client, and a manual walk back. The app already knows how to land on an arbitrary message (t175 jump mode) — the only missing piece was reading the link.

## Acceptance criteria

- [x] Clicking a `teams.microsoft.com/l/message/{convId}/{msgId}` link opens the target in-app
- [x] Clicking a link to a message in the CURRENT conversation jumps without a pane switch
- [x] Clicking a link to a message in ANOTHER conversation opens that conversation, then jumps
- [x] A link to a message not currently loaded still lands (jump mode fetches a window around it)
- [x] This app's own `/chat/c/{convId}?msg={msgId}` links resolve the same way
- [x] Cmd/Ctrl/Shift/Alt-click keeps its browser meaning (new tab / window)
- [x] A non-message link is untouched and still opens externally
- [x] A `javascript:` or `data:` URL never reaches the click handler
- [x] A `/chat/c/` link from a DIFFERENT origin is not resolved locally

## Test plan

### Layer 1 — Pure logic (TDD)

- [x] `parseMessageUrl` — round-trips a URL produced by `buildTeamsMessageUrl`
- [x] `parseMessageUrl` — parses a Teams link with and without the `context` param
- [x] `parseMessageUrl` — decodes a percent-encoded conversation id
- [x] `parseMessageUrl` — accepts the regional Teams hosts
- [x] `parseMessageUrl` — parses this app's own deep link; returns null when `?msg=` is absent
- [x] `parseMessageUrl` — rejects a foreign-origin `/chat/c/` link
- [x] `parseMessageUrl` — rejects a lookalike host (`evilteams.microsoft.com.attacker.test`)
- [x] `parseMessageUrl` — rejects non-http(s) schemes
- [x] `parseMessageUrl` — rejects a non-numeric message id, channel links, and junk

### Layer 2 — Manual smoke (CDP/IPC)

- [x] Paste a self-chat message link into self-chat, click it — lands and highlights
- [x] Click a link pointing at a different conversation — pane switches, then lands

### Layer 3 — Visual review

- [x] The landing flash reads the same as a citation-chip jump (same affordance, same feedback)

## Design notes

The link *builder* already existed for the "Copy link" menu items; this adds the inverse and wires it to the existing jump path. Almost no new behavior is introduced — the click is simply routed to a handler that was already there for citation chips.

- **Contracts changed:**
  - `MessageRowProps` — new optional `onOpenMessageLink(convId, msgId)`; absent → links stay external
  - `ThreadViewProps` — new optional `onOpenMessageLink(convId, msgId)`, for cross-conversation targets only
- **New modules:** none — `parseMessageUrl` joins the existing builders in `chat/src/lib/message-url.ts`
- **New ADR needed?** no

Routing is split by who owns the answer: the thread pane resolves a same-conversation target itself (it already has the jump), and only hands *up* a target it cannot serve. The app-level handler is the same `openCitation` that citation chips use, so cross-conversation jumps inherit behavior that is already proven.

Host matching is exact-or-subdomain rather than suffix. A suffix check accepts `evilteams.microsoft.com.attacker.test`, which is the standard way this kind of allowlist is bypassed.

```ts
interface MessageUrlTarget {
  convId: string
  msgId: string
}
// null = "not a message link we can resolve" → leave it external
parseMessageUrl(raw: string, origin: string): MessageUrlTarget | null
```

## Out of scope

- **Rendering the linked message's content inline** as a preview card. Deliberately deferred: it needs a cross-conversation fetch and a new card surface, and it interacts with the stored-body staleness trap. The jump delivers most of the value at a fraction of the cost.
- Channel message links (`/l/channel/…`) — this surface lists chats only, and the channel link shape carries fields we cannot populate
- Unfurling message links into rich previews in the conversation list

## Definition of Done

- [x] Layer 1 tests written and green
- [x] Layer 2 smoke checklist completed
- [x] `pnpm check` clean
- [x] `pnpm typecheck` clean
- [x] `pnpm test` green
- [x] No commented-out code, no `console.log` debris, no AI attribution
- [x] Task closed: status → done, file moved to `docs/tasks/done/`, t183 in commit

## Notes

Returning `null` for anything unrecognized (rather than throwing or best-guessing) keeps the failure mode boring: an unparseable link is just a link, exactly as before.

The refusal to resolve a foreign-origin `/chat/c/` link matters more than it first appears — conversation ids are not origin-scoped, so a link from another deployment would otherwise jump to a completely unrelated local conversation that happens to share the id.
