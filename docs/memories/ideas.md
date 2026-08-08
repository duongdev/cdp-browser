# Ideas backlog

Feature ideas, nice-to-haves, and future directions that don't belong in active tasks. These are *not* committed work — they're seeds.

**Format:** one line per idea, prefixed with `YYYY-MM-DD`. Newest at the top. Promote to a task file when the idea is ready to spec.

---

- `2026-08-07` **Inline preview for a linked message.** t183 makes a Teams message link jump in-app; rendering the linked message's *content* inline as a preview card is the richer treatment. Deferred: it needs a cross-conversation fetch plus a new card surface, and it inherits the stored-body staleness trap below (a preview built from the store may show a stale render). The jump delivers most of the value at a fraction of the cost.
- `2026-08-07` **Mentions in edits.** t182 threads mentions through the attachment send paths. The EDIT path still takes plain text and has no mention affordance at all, so editing a message that had mentions cannot preserve or add them. Small and self-contained if it ever bites.
- `2026-08-07` **Teams link unfurls.** 64 of 1963 probed messages carry `properties.links[].preview.{title,description}` that we never render, while Teams web shows a card. Deferred out of t181: sampled titles were junk ("Log in with Atlassian account") and `previewurl` was empty on every sample, so rendering them adds noise, not signal. Revisit gated on a non-empty `previewurl`.
- `2026-08-07` **Teams call transcripts.** 13 of 1963 probed messages are `RichText/Media_CallTranscript`, currently dropped as control noise while recordings chip correctly. Teams web offers an openable "Transcript". Cheap to add if anyone asks.
- `2026-08-07` **`<cite>` citation styling.** 18 probed messages carry `<cite itemtype=…/Citation>[1]</cite>`. `cite` is outside the DOMPurify allowlist, so the tag is stripped — `KEEP_CONTENT` preserves the `[1]` text, so meaning survives unstyled. Purely cosmetic.
- `2026-08-07` **Backfill stored message bodies after a renderer fix.** `store.ts` persists the RENDERED `ChatMessage` in the `raw` column, so a renderer improvement only reaches messages that get re-fetched (the newest ~30 of a thread). Older DB-served pages keep the old body forever. A re-render pass over the store would fix that; deliberately out of t181's scope.
