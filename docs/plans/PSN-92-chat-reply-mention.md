# PSN-92 — Reply & mention feature (plan)

Status: plan-only (grill phase). Implementation happens on this issue after the
label flips to `build`.

Linear: [PSN-92](https://linear.app/withdustin/issue/PSN-92/chat-reply-and-mention-feature)

## Baseline audit (probed 2026-07-23, codebase + live host 100.85.206.8:9222)

What exists today in `/chat`:

- **Incoming reply render**: a Teams reply arrives as HTML with a leading
  `<blockquote itemscope itemtype="http://schema.skype.com/Reply" itemid="{origMsgId}">
  <strong itemprop="mri" itemid="8:orgid:{oid}">Author Name</strong>
  <span itemprop="time" itemid="{origMsgId}"></span>
  <p itemprop="preview">quoted text…</p></blockquote>` followed by the reply body
  (live-verified). `blockquote` is in the sanitize allowlist
  (`chat/src/lib/sanitize-message.ts`) so the quote block renders in the thread;
  the conversation-list preview strips it (`core/teams-render.js`
  `quotedReplyPreview`).
- **Outgoing reply**: none. The composer (`chat/src/components/composer.tsx`) is
  stateless w.r.t. reply targets; `POST /api/teams/reply` takes `{convId, text,
  html}` only — no parent-message concept anywhere.
- **Incoming mentions**: rendered and merged. Teams splits one person into
  per-token `<span itemtype="http://schema.skype.com/Mention" itemid="N">` spans
  plus a `properties.mentions` JSON string
  `[{"@type":"http://schema.skype.com/Mention","itemid":N,"mri":"8:orgid:{oid}",
  "mentionType":"person","displayName":"token"}]` (live-verified);
  `core/teams-render.js` merges adjacent same-mri spans into one `@Name` pill
  (t140) and flags `mentionsMe` (t160).
- **Outgoing mentions**: zero. No autocomplete, no pill insertion, no
  `properties.mentions` encoding in the send path.
- **Mention/roster data**: `users` table in `core/teams-store.js` caches
  `mri → display_name` (resolve-once via Graph `getByIds`). No conversation
  rosters cached; live probe confirms `GET {chatService}/v1/threads/{id}`
  returns the member mri list in-page.
- **Names setting** (t161): `chat/src/lib/display-name.ts` — `NamePref`
  (`full | first | regex`), consumed by message rows, thread header,
  conversation rows, reactor tooltips. NOT applied to mention pills or quoted
  reply author names (both are baked into sanitized HTML).
- **Hover cluster**: `message-row.tsx` already has a reveal cluster (quick-react
  bar + ⋯ edit/delete menu) a Reply button can join.
- **Tooltip**: Radix tooltip exists at `src/components/ui/tooltip.tsx`; chat
  currently uses native `title` attrs only.

### Root cause of the "Display Name" bug (confirmed live)

Messages sent from our app post `imdisplayname: cred.displayName || ""` — and
`cred.displayName` is **never set** (no producer anywhere in `core/` or
`web/server.mjs`), so every message we send carries an empty `imdisplayname`.
When a colleague replies to such a message, **their** Teams client composes the
quote blockquote from the original message's stored `imdisplayname` and falls
back to the literal placeholder **"Display Name"** when it is empty.

Live proof: replies quoting our app-sent messages
(`19:a665fbe1…`, msg `1784701664692` "not too natural") show
`<strong>Display Name</strong>` while the original message has
`imdisplayname: ""` and a self `from` mri.

Consequences:

- Send-side fix (stamp the real self name) fixes all **future** quotes — for
  everyone, including what colleagues see in real Teams.
- Already-sent quotes are frozen in the reply's content; only a render-side
  fallback (resolve the `<strong itemprop="mri" itemid>` oid through the users
  cache; self → "(You)") can fix those, and only inside our app.

## Workstreams

Each sized for one session. Lettered for the build phase (`docs/tasks/tNNN` at
pickup).

### A — fix: reply quotes show "Display Name" instead of the real name

1. **Send-side**: populate `imdisplayname` on every outgoing message (reply,
   edit path untouched — Teams keeps the original), sourced from the self
   display name. Source order: users-cache name for `selfMri` → one in-page
   Graph `/me` fetch cached on the cred. Applied in
   `web/server.mjs` `sendTeamsMessageInPage` payload.
2. **Render-side fallback**: in `core/teams-render.js`, when the reply
   blockquote's `<strong>` text is empty or the literal "Display Name", resolve
   the author from `itemprop="mri" itemid` (oid → users cache); the viewer's own
   oid renders the real name too (decision 4 — no "(You)" special case in
   quotes). Applies retroactively to old broken quotes in our app.
3. Tests: pure render tests for the fallback (named strong kept, placeholder
   replaced, self resolved to real name); live self-chat verification that a
   fresh send carries the real name.

Acceptance: new sends store the real name (verified via live payload read);
old broken quotes show the real name / "(You)" in `/chat`.

### B — feat: hover-to-reply (single target)

1. Reply button joins the `message-row.tsx` hover cluster (fine-pointer fade-in,
   coarse-pointer visible, same dismiss pattern).
2. Reply-target state lives in `thread-view.tsx`; a quoted-preview chip renders
   above the composer (author + one-line preview + ✕ to cancel; Esc cancels).
3. Send path: pure builder `core/teams-reply-quote.js` —
   `buildReplyBlockquote({msgId, authorMri, authorName, previewText, ts})` emits
   the exact live-verified blockquote markup; client prepends it to the outgoing
   HTML. `POST /api/teams/reply` unchanged (content already rides `html`).
   Preview text = plain-text body, truncated like Teams (~120 chars).
4. Optimistic bubble renders the quote immediately (already works — body HTML
   passes through the existing blockquote render path).
5. Click a quote block → scroll to the original message if loaded, brief
   highlight (in scope per decision 3; if the original isn't in the loaded
   pages, no-op — don't fetch-walk history for it).

Acceptance: hover → Reply → chip appears → send lands in real Teams as a proper
quoted reply (self-chat live test); Esc/✕ cancels; TDD on the builder.

### C — feat: multi-message reply (Teams parity)

Extends B: reply-target state becomes an ordered list; selecting Reply on more
messages stacks chips; send prepends one blockquote per target (order =
selection order, matching Teams' stacked-quote behavior).

Acceptance: 2+ targets stack in the chip row and in the sent message (live
self-chat verification renders both quotes in real Teams).

### D — feat: `@` mention autocomplete

1. **Candidates**: new `POST /api/teams/roster {convId}` — in-page
   `GET /v1/threads/{id}` → member mris → names via users cache + one Graph
   `getByIds` batch for misses (same seam as t131). In-memory TTL cache per
   conversation; 1:1s synthesize the two members (other person + self, decision
   2 — dropdown shows in 1:1s too) without a thread fetch.
2. **Composer**: typing `@` opens a dropdown (filter as you type, ↑↓/↵/Esc,
   Vietnamese-diacritic-safe filtering via the existing fold helper); selecting
   inserts a non-editable mention pill (`contenteditable=false` span) into the
   contenteditable.
3. **Send encoding**: `outgoingFromEditor` maps pills →
   `<span itemtype="http://schema.skype.com/Mention" itemscope itemid="N">Name</span>`
   + `properties.mentions` JSON string (mri, mentionType "person",
   displayName). We send **one span per person** (not Teams' per-token split) —
   to be verified live in self-chat at build; fall back to per-token split only
   if the single span renders wrong in real Teams.
4. `POST /api/teams/reply` accepts an optional `mentions` property and threads
   it into the send payload's `properties`.

Acceptance: `@` → dropdown of conversation members → pill in composer → sent
message renders as a real mention in Teams (recipient gets a mention, verified
self-chat + payload read); pure tests on encoding + candidate filtering.

### E — feat: names respect Names setting + full-name tooltip

1. Client-side post-sanitize DOM pass (pure helper in `chat/src/lib/`): apply
   `formatName(…, namePref)` to `.mention` pill text and reply-quote author
   `<strong>` text; the viewer's own quote shows the real name (decision 4);
   mention pill keeps the "@you" highlight behavior.
2. Hover tooltip: sender names (message rows, thread header, quote authors,
   mention pills) show the raw full name in a Radix tooltip **only when the
   Names setting shortens it** (pref ≠ full, decision 5). Reactor `title` attrs
   upgraded to the same tooltip.

Acceptance: with Names = first/regex, mentions + quotes shorten consistently;
hover reveals full raw name; with Names = full, no tooltip noise.

### F — world-class review + bug sweep (last)

Per-area pass against benchmark chat apps (Teams, Slack, Discord): reply
affordance discoverability, chip UX, mention dropdown keyboard behavior, quote
click-to-jump, dark/light contrast of quote blocks and pills. Fix what's cheap,
log the rest as carry-overs. Final regression sweep (send/edit/delete/react
still green), typecheck/tests/build, live verification.

## Dependency / parallelism table

| Workstream | Depends on | Parallel with | Touches |
|---|---|---|---|
| A (Display Name fix) | — | D, E | server send payload, teams-render, users cache |
| B (reply UI) | — | D | message-row, thread-view, composer, new core builder |
| C (multi-reply) | B | D, E | thread-view, composer chip row |
| D (mention autocomplete) | — | A, B, C | composer, new roster endpoint, teams-store users |
| E (names + tooltip) | A (quote author seam) | C, D | render post-pass, tooltip, message-row |
| F (review + sweep) | all | — | cross-cutting |

Suggested sequence (one branch, one PR): A → B → C → D → E → F. A first —
smallest, ships the visible bug fix, and creates the quote-author seam E needs.

## Constraints

- Live probes are read-only; all send/mention/reply live tests happen in
  self-chat (`48:notes`) or a self-DM only. No mutations on threads with other
  users.
- `/` browser build stays byte-unchanged; server changes are additive
  endpoints/payload fields.
- All new pure logic (quote builder, mention encoding, name post-pass,
  candidate filtering) is TDD-tested per `docs/conventions/tdd.md`.

## Risks

- **Outgoing mention shape**: single-span mentions are an assumption until the
  self-chat live test; per-token fallback is the escape hatch (D absorbs it).
- **Roster size**: large org channels could return huge member lists; cap the
  dropdown to recent senders + prefix matches if `/v1/threads` is heavy.
  `/chat` is DM/group-DM-focused, so this is edge, not core.
- **Old quotes elsewhere**: colleagues' Teams keeps showing "Display Name" for
  already-sent messages; only future sends are fixed for them (content is
  immutable without editing each message). Accepted (grilled 2026-07-23).
- **contenteditable pills**: caret behavior around non-editable spans is
  fiddly (deletion, IME); keep the pill atomic (single backspace removes it)
  and test with Vietnamese Telex.

## Out of scope

- Editing old messages to repair historical "Display Name" quotes.
- Channel-wide `@team`/`@channel` mentions (person mentions only).
- Mention notifications plumbing (already handled by `mentionsMe`, t160).
- Reply threading UI beyond quote blocks (Teams chat has no real threads).

## Decisions (grilled 2026-07-23)

1. **Multi-reply UX (C)**: confirmed — stack N quote chips above the composer,
   one send carrying N blockquotes (Teams' select-multiple behavior).
2. **Mention candidates in 1:1 DMs (D)**: show the dropdown (other person +
   self).
3. **Quote click-to-jump (B5)**: in scope — scroll to the original + brief
   highlight when loaded.
4. **Self name in quotes (A/E)**: real name, not "(You)".
5. **Tooltip scope (E)**: only when the Names setting shortens (pref ≠ full).
6. **Historical quotes in colleagues' Teams**: accepted as unfixable; only
   future sends carry the real name for them.
