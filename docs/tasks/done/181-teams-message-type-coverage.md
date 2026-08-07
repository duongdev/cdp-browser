# 181 — cover the Teams message types that render empty or lossy

- **Status:** done
- **Mode:** AFK
- **Estimate:** 1d
- **Depends on:** t141 (attachment chips), t151 (card fallback), t162 (recording chips)
- **Blocks:** none

## Goal

Five classes of Teams message currently lose content between the provider payload and the rendered bubble: an uploaded image degrades to a filename chip, a Loop/Fluid embed disappears entirely, a video-only message renders as a blank bubble, a bot's adaptive card collapses to the word "Card", and a forwarded block is indistinguishable from a reply. After this task each of them renders what Teams web renders. The governing rule: if Teams web can display it, CDP Chats should too.

## Why now

Three of these were reported directly (an image that arrived as a chip, a Loop embed that arrived as nothing, plus the blank bubbles found while probing). A live probe of 1963 raw messages across 20 conversations quantified the rest — 206 messages, the single largest class in the corpus, currently render a chip that says nothing.

## Evidence

Probe method: read-only CDP fetch mirroring `web/server.mjs` `fetchTeamsHistoryInPage`, then each raw payload run through `core/teams-render.js` and diffed raw-vs-rendered.

| # | Gap | Messages | Root cause |
|---|---|---|---|
| A | image sent as a file upload → chip only | 11 | `parseFiles` drops `filePreview.previewUrl` (a valid AMS url) and flattens every file to `kind:"file"` |
| B | Loop/Fluid embed renders nothing | 1 + 12 | `FluidEmbedCard` payload lives in `properties.cards`, but `renderBody` returns early on visible text so the card path never runs; `FluidAutoEmbedLink` is an `<a>` with no text node |
| C | video-only message → blank bubble | 3 | `hasVisibleText` tests `/<img\b/` only, not `<video` |
| D | bot adaptive card → chip reading "Card" | 206 | the payload is base64 in `<Swift b64="…">`; `parseUriObjects` reads only `<Title>`, and `cardFallback` reads `properties.cards`, which is empty for these |
| E | forwarded block unlabelled | 5 | `<blockquote itemtype=".../Forward">` gets no marker, unlike a Reply quote |

Explicitly verified as NOT broken, do not touch: `CustomEmoji` (already `class="emoji"`), code blocks, PDF/json/html chips, reactions, mentions, reply quotes, `Event/Call`, `ThreadActivity/*`, and the 31 deliberately-dropped in-progress recording chunks (t162).

## Acceptance criteria

- [x] An image upload with a valid AMS `filePreview.previewUrl` renders inline through the media proxy, with its box reserved, and opens in the lightbox.
- [x] An image upload with a missing or non-AMS preview still renders as a file chip — never a broken `<img>`.
- [x] A `fluidEmbedCard` message renders a card chip linking to its `componentUrl`, alongside any body text.
- [x] An empty `FluidAutoEmbedLink` anchor renders a visible, clickable label.
- [x] A video-only message renders its `<video>`, not an empty bubble.
- [x] A SWIFT card renders the card's real title and text, and a malformed payload falls back to today's generic chip without throwing.
- [x] A forwarded blockquote is visually marked as forwarded; a reply quote is unchanged.
- [x] The gap census over the same 1963-message corpus reports 0 for every counter above.
- [x] `core/teams-render.js` stays pure — no I/O, no DOM.
- [x] No new dependency. No adaptivecards package (grilled #7).

## Test plan

### Layer 1 — pure logic (TDD), `core/teams-render.test.ts`

Fixtures are taken verbatim from the captured corpus, not invented HTML.

- [x] `parseAttachments` — png upload with AMS `filePreview` → `kind:"image"`, proxied `thumbnailUrl`, `width`/`height` set
- [x] `parseAttachments` — png upload with a non-AMS preview url → `kind:"file"` (SSRF gate holds)
- [x] `parseAttachments` — png upload with no `filePreview` → `kind:"file"`
- [x] `parseAttachments` — pdf → `kind:"file"`, unchanged
- [x] `renderBody` — video-only body keeps its `<video>` element
- [x] `renderBody` — genuinely empty body still falls back to the chip
- [x] `parseAttachments` — SWIFT with `Swift b64` → card title + text from the decoded AdaptiveCard
- [x] `parseAttachments` — SWIFT with malformed base64 → generic chip, no throw
- [x] `parseAttachments` — CallRecording path unchanged (regression guard for t162 chunk-dropping)
- [x] `parseAttachments` — `fluidEmbedCard` → `kind:"card"` with `componentUrl`
- [x] `renderBody` — empty `FluidAutoEmbedLink` anchor gets a label; a non-empty anchor is untouched
- [x] `renderBody` — Forward blockquote gets `class="forward"`; Reply blockquote unchanged

### Mutation check

Revert each production line individually and confirm the matching test goes red. A green suite not wired to the behaviour it names is worse than no suite.

### Layer 2 — corpus regression

Re-run the gap census over the captured 1963-message corpus; every counter in the evidence table must reach 0.

### Layer 3 — visual

`pnpm chat:mock` with the captured payloads seeded. Screenshot each of the five classes. Filter DOM queries by `getBoundingClientRect().width > 0` — `thread-view` keeps inactive panes mounted under `display:none`. Do **not** verify on a preview deploy: previews share the real `/data` volume and drive the live Teams session.

## Design notes

`ChatAttachment.kind` gains `"image"`, plus optional `width`/`height`. A distinct kind rather than `"file"` + a truthy `thumbnailUrl`, because the FE behaviour differs in kind: an inline media surface and a lightbox target, not a chip.

`core/teams-render.js`:

| function | change |
|---|---|
| `parseFiles` | image `fileType` + AMS-valid `filePreview.previewUrl` → `kind:"image"` with proxied `thumbnailUrl` and dimensions; everything else unchanged |
| `hasVisibleText` | `/<img\b/i` → `/<(?:img\|video)\b/i` |
| `parseUriObjects` | decode `<Swift b64>` and feed the existing `collectCardText`/`stripCardMarkup` path |
| `parseFluidCards` (new) | `properties.cards` entries with a `fluidEmbedCard` contentType → `kind:"card"` + `componentUrl` |
| `labelFluidLinks` (new) | give an empty `FluidAutoEmbedLink` anchor a text child |
| `labelForwards` (new) | add `class="forward"` to a Forward blockquote |

`chat/src/lib/sanitize-message.ts` needs **no** allowlist change: `img`, `video`, `class`, `width`, `height` are already permitted.

SWIFT payloads are untrusted third-party base64→JSON. Parse defensively, reuse `CARD_TEXT_CAP` and the existing escaping, render no card actions.

## Known trap

`store.ts` persists the **rendered** `ChatMessage` in the `raw` column and `toChatMessage` (`routes.ts:857`) returns it verbatim, so a renderer fix does not retroactively repair stored rows. `teamsHistory` re-upserts on fetch, so the newest ~30 messages of a thread self-heal when opened; older DB-served pages keep the old body. Verification must use freshly fetched threads.

## Out of scope

- Backfilling already-stored message bodies (separate task if wanted).
- Link unfurls from `properties.links` (64 msgs) — sampled previews are junk and `previewurl` was empty on every sample. Deferred to `docs/memories/ideas.md`.
- Call transcripts (13 msgs) — still skipped as control noise.
- `<cite>` citation styling (18 msgs) — stripped by the allowlist but `KEEP_CONTENT` preserves the `[1]` text, so meaning survives.

## Verification record

| Gate | Result |
|---|---|
| `core/teams-render.test.ts` | 121 passed (12 new t181 suites) |
| Mutation check (`scripts/t181-mutation-check.mjs`) | 9/9 mutants killed |
| Corpus regression (`scripts/t181-corpus-regression.mjs`) | 1963 raw → 1870 rendered, all gap classes 0 |
| `pnpm typecheck` | clean |
| `pnpm test` | 2490 passed (183 files), no regression |
| `pnpm build` + `node --check web/server.mjs` | clean |
| Biome on changed files | 0 errors |
| Visual (`pnpm chat:mock`) | all five classes verified in the live DOM — inline image loads (96×96 natural size) and opens the lightbox, Loop chip + "Loop page" link carry hrefs, `<video>` present, decoded card shows its question text, `FORWARDED` label renders |

The mutation check earned its keep: it found that `componentUrl` reached the chip's `href` with no scheme guard, so a `javascript:` payload from a hostile card would have ridden through. Test added, gate added, mutant killed.

## Definition of Done

- [x] All acceptance criteria checked
- [x] Layer 1 tests written first, seen red, then green
- [x] Mutation check passed
- [x] `pnpm typecheck && pnpm test && pnpm build` clean
- [x] Biome clean on the changed files
- [x] This file moved to `docs/tasks/done/` in the shipping commit
