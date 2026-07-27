# PSN-104 — Assistant reads images in messages

Follow-on to the AI assistant epic (ADR-0021, t171–t177). Today an image in a Teams message is
invisible to the assistant: `stripHtml` (`apps/chat-server/src/search.ts`) deletes `<img>` outright,
so it is neither indexed nor mentioned in any tool result. This plan gives the assistant two ways to
read an image — a searchable transcription made once at ingest, and raw pixels on demand when the
question needs them.

## Baseline (probed)

- Teams inline images are AMS objects. `core/teams-render.js` rewrites their `src` to
  `/api/chat/media?service=teams&url=<ams>`; the bytes come back through the BFF's
  `provider.media(url)` → `/internal/teams/media` → an **in-page** authenticated fetch (CA-proof),
  LRU-cached on the web server. Nothing new is needed to *get* an image server-side.
- **`tool.toModelOutput` multimodal is a dead end here.** `@ai-sdk/openai-compatible@3` maps a
  `{type:'content'}` tool output through `JSON.stringify` into the `role:"tool"` message
  (`convertToOpenAICompatibleChatMessages`), so an image part would arrive as stringified base64
  garbage. Images must ride as **user-role** parts — those it maps correctly to `image_url`/data
  URLs. Hence the `prepareStep` injection below.
- `ai@7` exposes `prepareStep`, which can rewrite the message list per step — the seam for injecting
  fetched bytes on the step after the tool call.

## Decisions (grilled 2026-07-27)

1. **Both paths, not one.** Caption at ingest (searchable, cheap, always there) *and* an on-demand
   `view_image` tool (real pixels when the caption isn't enough).
2. **Captioning runs on `LLM_CAPTION_MODEL`** (falls back to `LLM_MODEL`), in an **async queue** —
   the sweep upserts the message and enqueues; it never blocks on the router.
3. **AMS inline images only.** Emoji, stickers, Giphy, card/recording thumbnails and SharePoint file
   attachments are out (noise per caption call, or a different fetch path). PDFs deferred.
4. **Vision gate = probe + env override.** `enrichModelLimits` already reads the router's
   `/v1/models`; read the modality field the same shape-tolerant way. No vision → no `view_image`
   tool, and the system prompt tells the model to lean on captions. `LLM_VISION_MODELS` force-lists.
5. **Lazy backfill.** Only new images caption at ingest; an old one captions the first time it is
   viewed (agent or lightbox), then caches. No bulk run, no deploy-time queue storm.
6. **No per-turn image cap, server-side downscale instead** (~1024px long edge, `sharp`). The step
   cap (8) is the only bound on how many images a turn can pull.
7. **Caption = full transcription, no length cap.** Verbatim text first (error strings, ticket ids,
   names, code), then what the image is. The lightbox shows it behind a show-more, scrollable.
8. **Caption is user-visible** — the image lightbox renders it, with a pending state while the queue
   works.

## Approach

**Storage.** New `message_media` table in the BFF store (service-agnostic, like everything else):
one row per image, keyed by its AMS object id (`amsObjectId`, already parsed in `core/teams-media.js`)
plus `(service, convId, msgId, idx)`. Columns: `caption`, `status` (`pending|done|failed`), `error`,
`ts`. Object-id keying means the same screenshot forwarded twice captions once.

**Indexing.** `syncMessageFts` appends the message's captions to its indexed text, so a screenshot's
contents are searchable through the existing `search_messages`. A caption landing later re-syncs that
one row.

**Agent surface.**
- `stripHtml` emits `[image#N]` instead of deleting the tag, so every tool result that shows message
  text also shows that an image exists.
- `get_context` / `search_messages` rows carry the caption (or `caption: null, status: "pending"`).
- New `view_image({convId, msgId, index})` tool (registered only for a vision model): fetches +
  downscales, stashes the bytes in a per-turn buffer, returns a text ack. `prepareStep` drains the
  buffer into a `role:"user"` message with the file parts before the next step. The `(convId, msgId)`
  goes through `onSurfaced`, so a claim about an image can be cited like any other message.

**FE.** The lightbox (`chat/src/components/image-lightbox.tsx`) shows the caption: pending shimmer →
transcription, collapsed with show-more, scrollable. Caption completion arrives as a WS delta so an
open lightbox flips without a refetch.

## Workstreams

| # | Workstream | Depends on |
|---|---|---|
| A | `message_media` table + caption queue + `LLM_CAPTION_MODEL` + FTS sync | — |
| B | `stripHtml` `[image#N]` marker + captions on tool results | A |
| C | Vision probe (`enrichModelLimits` modality + `LLM_VISION_MODELS`) | — |
| D | `view_image` tool + `prepareStep` injection + `sharp` downscale | A, C |
| E | Lightbox caption UI (pending / show-more / scroll) + WS delta | A |

## Acceptance criteria

- [ ] A new image message is captioned within seconds of arriving; the sweep is never blocked by it.
- [ ] Searching a phrase that only exists *inside* a screenshot finds that message.
- [ ] Asking "what does the screenshot in X say" on a vision model returns detail beyond the caption,
      with a working `[msg:…]` citation.
- [ ] On a non-vision model the same question is answered from the caption, and no tool error occurs.
- [ ] An uncaptioned historical image captions on first view and stays cached.
- [ ] The lightbox shows pending → transcription, long text scrolls behind show-more.
- [ ] A router/caption failure leaves the message intact and the image still viewable.

## Risks

- `sharp` is a native dependency new to the BFF image — must build for the deploy platform.
- Image bytes and their transcriptions go to the router (same trust boundary as message text today,
  but a screenshot can carry more than the operator expects).
- Router modality reporting is inconsistent; the env override is the escape hatch.

## Out of scope

SharePoint file attachments, PDFs, video, emoji/sticker/GIF captioning, bulk historical backfill,
sending images from the assistant.
