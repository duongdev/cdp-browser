# PSN-94 — Chat input rich enhancement (plan)

Status: grilled — decisions resolved · plan-only · 2026-07-25
Issue: https://linear.app/withdustin/issue/PSN-94

Close the gap between the `/chat` composer and the native Teams web composer:
code/quote/link authoring, a width-responsive Format toggle, live markdown
auto-convert, an emoji picker in the composer, and native-round-trip GIF +
sticker pickers. Each workstream is sized for one session.

## Baseline (probed 2026-07-25, code audit)

- **Composer** (`chat/src/components/composer.tsx`): contenteditable card.
  Enter=send / Shift+Enter=newline / ⌘·Ctrl+Enter=send (`enterKeyAction` in
  `chat/src/lib/rich-compose.ts`). Toolbar = **bold, italic, underline,
  strikethrough, bulleted list, numbered list** via `document.execCommand`
  (`FORMAT_ACTIONS`, always-visible row). @-mentions with lazy roster
  autocomplete (`mention.ts`). File attach (button) + image-paste staging
  (`pickFiles`). Reply/quote chips. **Paste is plain-text-forced.**
- **Send shaping** (`rich-compose.ts` `outgoingFromEditor`): editor HTML →
  `{ text, html, displayHtml, mentions }`. `cleanEditorHtml` allowlist already
  includes `code, pre, blockquote, a` — the wire path can already carry them;
  nothing in the UI authors them. `FORMAT_TAG_RE` decides Text vs RichText/Html.
- **Render** (`chat/src/lib/sanitize-message.ts`): DOMPurify allowlist includes
  `code, pre, blockquote, a, span, img`. `core/teams-render.js` + `index.css`
  (`.teams-message-body`) already size inline emoji (1.25em), stickers, and
  public-CDN GIFs; AMS media rides the `/api/chat/media` proxy (t139).
- **Emoji** (`chat/src/components/emoji-picker.tsx` + `emoji-catalog.ts`):
  full searchable, category-grouped picker with a unicode `u` field — but wired
  **only** into message-row reactions (`message-row.tsx:698`), never the
  composer.
- **GIF/sticker authoring**: none. Render can display them (they arrive as
  public-CDN `<img>` / AMS objects), but there is no picker and no send path.
- **Precedent for media send**: t145 `upload-image` proves the in-page AMS
  upload + inline-image send flow (`/api/teams/upload-image` → `buildAmsImageContent`).
  GIF/sticker native round-trip is the analogous problem — a different Teams
  wire object, to be reverse-engineered.

## Decisions (grilled 2026-07-25)

1. **Scope = all four groups.** Code+quote+link authoring · emoji-in-composer ·
   full markdown auto-convert · GIF + sticker pickers. GIF/sticker get a
   feasibility spike first — **push back if too complex** (standing instruction).
2. **GIF/sticker fidelity = native round-trip required.** A GIF/sticker sent
   from `/chat` must render as a proper animated GIF / sticker in the real Teams
   client, not a flat inline image. Method: **read a native-Teams-sent GIF in
   the self-note chat first (no mutation), reverse-engineer its wire object,
   replicate, then verify** the round-trip in self-note.
3. **Probe targets:** the self-note chat (send tests) and *Ethan Nguyen - Group
   Office \[C\]* (`19:32d3ad41-12e3-42c3-b5a2-76e66f2ec107_623d9d09-8883-43fc-a957-17a73b5ee4f3@unq.gbl.spaces`)
   for read-only inspection of native-produced GIFs. **Send tests go to
   self-note only** — no mutations on other users' threads (issue constraint).
4. **Action-bar layout = Format toggle, width-responsive.** A Format (Aa) button
   reveals bold/italic/underline/strike/code/codeblock/quote/link/clear. The
   always-visible bar keeps attach · emoji · GIF · sticker · send. Collapse
   aggressively on narrow widths, expand inline when there's room.
5. **Markdown = full auto-convert**, live as you type: `**b**` `*i*` `_i_`
   `~~s~~` `` `code` `` ` ```block``` ` `> quote` `- ` / `1. ` lists.
6. **Out:** `:shortcode:` emoji autocomplete, auto-link typed URLs (both
   explicitly deselected). Keep plain-text-forced paste.

## Workstreams

| WS | Title | Depends on | Model | Parallel? |
|----|-------|-----------|-------|-----------|
| A | Format toggle + code/quote/link/clear-format buttons (width-responsive bar) | — | opus | with D-spike |
| B | Markdown live auto-convert | A | opus | after A |
| C | Emoji picker in composer | A | sonnet | after A |
| D | GIF: spike → Giphy picker → native-round-trip send | — | opus | with A |
| E | Sticker: spike → picker (or documented pushback + fallback) | D | opus | after D |
| F | Bug sweep + polish + docs | A–E | sonnet | last |

A is the layout foundation B and C both build on, so it lands first; D's spike
can run in parallel since it touches the send path + BFF, not the toolbar layout.
E reuses D's wire-format learnings.

### A — Format toggle + code/quote/link/clear-format
- Add a `Format` (Aa) toggle; move the 6 existing + new **inline code, code
  block, blockquote, insert-link, clear-formatting** actions behind it.
- Always-visible bar: attach · emoji(C) · GIF(D) · sticker(E) · send.
- Width-responsive: measure container; inline the format row when wide, collapse
  to the toggle when narrow (reuse `use-shell-mode`/a ResizeObserver pattern).
- Insert-link: wrap the selection in `<a href>` (small dialog for the URL);
  clear-format: `execCommand("removeFormat")` + unwrap code/pre/quote.
- Code/quote author into the tags `cleanEditorHtml` + the sanitizer already allow
  — verify Text-vs-RichText branch flips (`FORMAT_TAG_RE` add `code|pre|blockquote`
  already present).

### B — Markdown live auto-convert
- Intercept input in the contenteditable; on a completed token, replace the
  markdown source with the formatted node (keep the undo stack sane — prototype
  early, this is the risky one).
- Inline: `**`/`__` bold, `*`/`_` italic, `~~` strike, `` ` `` code.
- Block: ` ``` ` opens a code block, `> ` a blockquote, `- `/`* `/`1. ` a list
  (native list behavior already handled by `caretInListItem`).
- Pure transform logic in a new `chat/src/lib/markdown-shortcuts.ts` (node-test),
  composer wires the DOM effect.

### C — Emoji picker in composer
- Emoji button in the always-visible bar → popover reusing `EmojiPicker`.
- `onSelect` inserts the catalog `u` (unicode) at the caret via `insertText`;
  refocus the editor. No `:shortcode:` autocomplete (out of scope).

### D — GIF (Giphy) with native round-trip
- **Spike (gate):** in self-note, inspect a native-Teams GIF message's raw
  payload (the BFF stores `raw` per message — read it) to learn the exact wire
  object (animated-media / URIObject / AMS-hosted). Document it. **If it needs a
  path we can't reproduce in-page → push back, fall to `/chat`-only `<img>` and
  flag the drift.**
- Giphy search picker (needs an API key + a BFF proxy mirroring `/api/chat/media`
  — content-rating filtered). Pure search/pagination in a lib, effect in a
  component.
- Send in the learned native format; verify it animates in the real Teams client.

### E — Sticker
- Same spike shape as D against a native sticker message. Teams stickers are a
  proprietary emoticon catalog — **expected pushback candidate.** If native
  round-trip isn't reproducible in-page, ship a small custom sticker set as
  `/chat`-only inline images and document the drift, or defer.

### F — Bug sweep + polish + docs
- Cross-workstream regressions (mention menu vs markdown keydown, paste, phone
  layout, focus retention across send). Update `CLAUDE.md` composer bullet +
  `CONTEXT.md` if a new wire object is introduced. `/polish` the diff.

## Acceptance criteria

- [ ] Format toggle reveals bold/italic/underline/strike/inline-code/code-block/
      quote/insert-link/clear-format; always-bar = attach/emoji/GIF/sticker/send;
      layout adapts to width.
- [ ] Inline code + code block author and round-trip in `/chat` **and** native Teams.
- [ ] Blockquote authors + round-trips.
- [ ] Insert-link wraps selection into a clickable `<a>`; clear-format strips it.
- [ ] Markdown `**/*/_/~~/`` ` ``/```/> /- /1.` auto-convert live.
- [ ] Emoji picker button inserts unicode into the composer; sends + renders.
- [ ] GIF picker sends a GIF that **animates in native Teams** (round-trip proven
      in self-note) — or a documented pushback with the `/chat`-only fallback.
- [ ] Sticker: native round-trip **or** documented pushback + fallback.
- [ ] `pnpm test` + `pnpm typecheck` + `pnpm check:changed` clean.
- [ ] Live `/cdp` verification against the probe host; send tests self-note only.

## Risks

- **R1 — GIF wire format not reproducible in-page.** Native Teams GIF may need an
  AMS upload or a proprietary animated-media object an in-page fetch can't build.
  *Mitigation:* spike reads a real native GIF first; push back to `/chat`-only if
  blocked (decision 1).
- **R2 — Sticker catalog proprietary.** Likely `/chat`-only fallback or defer.
- **R3 — Markdown transforms fight execCommand / the undo stack** in
  contenteditable. *Mitigation:* prototype B in isolation before wiring.
- **R4 — Giphy API key + rate limits + content rating.** Needs a key, a BFF proxy,
  and a rating filter; treat the key as config, not committed.
- **R5 — Mutation safety.** Send tests to self-note only; the group chat is
  read-only inspection.

## Out of scope

`:shortcode:` emoji autocomplete · auto-link typed URLs · rich paste (keep
plain-text) · Teams app-bar extensions (praise/approvals/loop/schedule-send) ·
typing indicators · read receipts · font size/color/highlight.
