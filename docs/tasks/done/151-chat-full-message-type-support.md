# 151 — teams chat: full message-type support (system lines, adaptive-card fallback, clean previews)

- **Status:** done
- **Mode:** HITL (live-verified against the real Teams tenant, read-only)
- **Depends on:** t129 (render), t133 (rich HTML + sanitize), t141 (URIObject chips), t149 (design tokens)
- **Workstream:** G (PSN-90 native chat UI enhancements)

## Goal

No Teams message renders as raw/garbled payload — especially meeting/call threads. Before this task
`core/teams-render.js` skipped every `ThreadActivity/*` and leaked `Event/Call` /
`Media_CallTranscript` as escaped-raw XML/JSON, `properties.cards` degraded to a literal `[card]`,
and the conversation-list preview leaked blockquote markup and system XML.

## Live enumeration (read-only side-channel, 46 conversations / ~1500 messages)

Enumerated the **distinct `messagetype` + `properties` shapes** actually present in the account
(all of conversation-list page 1, meeting threads included) via a second CDP client evaling an
in-page `fetch` of each conversation's raw messages. Distribution:

| # | messagetype | shape | before | after (t151) |
|---|---|---|---|---|
| 1013 | `RichText/Html` | site HTML | rich HTML ✓ | unchanged (+ dark-mode style guard) |
| 189 | `ThreadActivity/MemberJoined` | JSON `{members:[{friendlyname}]}` | **skipped** | system line "X joined" |
| 138 | `ThreadActivity/DeleteMember` | `<deletemember><target><initiator>` | **skipped** | "X left" (self-removal) / "X removed a member" |
| 136 | `Text` | plain text | escaped ✓ | unchanged |
| 133 | `Event/Call` | `<ended/><partlist count=N>` or `<partlist><meetingDetails>` | **escaped-raw ✗** | "Call ended · N people" ; bare meeting placeholder → skip |
| 99 | `RichText/Media_Card` | `<URIObject type="SWIFT.1">` | URIObject chip ✓ (t141) | unchanged |
| 52 | `RichText/Media_CallRecording` | `<URIObject type="Video.2/CallRecording.1">` | recording chip ✓ (t141) | unchanged |
| 13 | `RichText/Media_CallTranscript` | `{scopeId,callId,…}` JSON | **escaped-raw ✗** | skipped (control artifact, no value) |
| 12 | `ThreadActivity/TopicUpdate` | `<topicupdate><value>` | **skipped** | "X renamed the conversation to \"…\"" |
| 10 | `ThreadActivity/AddMember` | `<addmember><target>` | **skipped** | "X added a member" |
| 5 | `ThreadActivity/AddCustomApp` | `<AddCustomApp><targetName>` | **skipped** | "X added the {app} app" |
| 4 | `ThreadActivity/MemberLeft` | JSON `{members:[{friendlyname}]}` | **skipped** | "X left" |
| 2 | `ThreadActivity/MeetingPolicyUpdated` | `<meetingpolicyupdated>` | skipped | **stay skipped** (noise) |
| 1 | `ThreadActivity/PinnedItemsUpdate` | JSON `{operation}` | skipped | **stay skipped** (noise) |
| 1 | `ThreadActivity/UpdateFavDefault` | `<UpdateFavDefault>` | skipped | **stay skipped** (noise) |

Plus `properties.cards` (adaptive cards, a JSON STRING carrying `content.body[].TextBlock.text`) —
present alongside `RichText/Html` bodies; when it's the whole message it degraded to `[card]`.

### Support matrix (final)

- **Recognized `ThreadActivity/*` + `Event/Call` (ended)** → `{ kind: "system", body }` compact
  centered meta line. Names come from the payload (`friendlyname`, the message's `imdisplayname`),
  degrading to a generic actor ("Someone") — no MRI lookup in the pure module.
- **Low-signal / unknown `ThreadActivity` subtypes + `Media_CallTranscript` + bare meeting
  placeholders** → `null` → skipped (never rendered).
- **`properties.cards` (adaptive)** → a styled generic card block
  `<span class="teams-card"><span class="teams-card-title">…</span><span class="teams-card-body">…</span></span>`
  with best-effort title/summary extracted from the card JSON. No `adaptivecards` dep, no card
  actions (grilled #7).
- **`Media_Card` / `Media_CallRecording` (URIObject)** → unchanged t141 chips.
- **Any other non-html messagetype whose content is XML-ish** → quiet `[unsupported: {type}]` chip.
  A plain (non-XML) non-html body still escapes normally; `Text` stays escaped.
- **Final fallback is never raw payload text.**

## Changes

- `core/teams-render.js` (pure, TDD):
  - `systemEventText(message)` → a compact system line or `null` (per-subtype; unknown → null).
  - `isSystemMessage` now also matches `Event/Call` + `Media_CallTranscript`; `toReaderMessages`
    emits `{ kind: "system", body }` for recognized events instead of skipping all `ThreadActivity`.
  - `cardFallback(message)` — adaptive-card generic block (title/summary extracted, HTML-escaped);
    `attachmentChip` uses it instead of `[card]`.
  - `renderBody` — unknown non-html XML-ish content → `[unsupported: type]` (never escaped-raw).
  - `previewText(rawContent)` — reduces any raw last-message content to one clean plain-text line
    (quoted reply → replier's words / `↩ …`; system event → its line; card → its title; noise → "").
- `chat/src/lib/conversation-view.ts` — `previewLine` now routes through a mirrored `previewText`
  (the CJS core can't be imported into the typechecked chat bundle).
- `chat/src/components/message-row.tsx` — a `kind:"system"` message renders as a centered muted
  `SystemRow`; normal messages unchanged.
- `chat/src/lib/sanitize-message.ts` — `afterSanitizeAttributes` strips `style`/`bgcolor`/`color`
  (dark-mode carry-over guard: the root-cause fix at the boundary all bodies route through, so no
  presentational light background survives into dark mode; `style` was already outside the allowlist).
- `chat/src/index.css` — `.teams-card` block styling. No CSS `!important` override needed once the
  color attrs are stripped at the sanitizer.

## Acceptance

- [x] Committed support matrix built from **live-enumerated** data (above).
- [x] Meeting-thread messages render as intentional UI (system lines / card blocks / chips); zero
      raw payloads — **live-verified**: the `<ended/><partlist>` and transcript-JSON leaks are gone,
      "Call ended · N people" / "X left" / "renamed to …" render.
- [x] Renderer stays XSS-safe (all HTML through `sanitize-message.ts`; extracted card text escaped).
- [x] `core/teams-render.js` changes are pure + TDD (extends `core/teams-render.test.ts`).
- [x] Conversation-list previews are clean plain text for every enumerated shape.
- [x] Dark-mode carry-over neutralized.

## Verification

`pnpm test` (1383 pass), `pnpm typecheck`, `pnpm test:e2e` (49 pass), `pnpm chat:build` + `pnpm build`
(both clean), `node --check web/server.mjs`. Diff confined to `core/teams-render.js` (+ test) and
`chat/**`. The `/` renderer imports nothing new.

## Ceiling / follow-ups

- System-line names degrade to "Someone" when Teams omits `imdisplayname` on the activity message
  (no MRI→name resolution in the pure module); wire the t131 `users` cache through if it matters.
- Native adaptive-card render + inline recording playback stay deferred (grilled #7 / CLAUDE.md).
