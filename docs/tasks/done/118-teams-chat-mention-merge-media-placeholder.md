# 118 — teams chat render fixes: mention-run merge + media dimension reservation (no scroll shift)

- **Status:** done
- **Mode:** HITL
- **Depends on:** t111 (render), t117 (media)

## Goal

Two user-reported gaps on shipped surfaces:
1. **Mention splitting** — Teams emits one person's @mention as per-token spans; we rendered each as
   its own pill ("@Glory @Nguyen @- @Group @Office @[C]"). Merge them into one pill.
2. **Scroll flicker from media** — some AMS images carry no `width`/`height` attrs (Teams encodes size
   as inline `style="width:Npx;height:Npx"`, which sanitize strips), so they render at height 0 until
   load then jump → content shift while scrolling. Reserve the box + a placeholder.

## PROVEN (live probes)

- A "Glory Nguyen - Group Office [C]" mention = **6** `<span itemtype=…/Mention itemid=N>token</span>`
  spans, and `properties.mentions` maps **every** itemid 0–5 to the **same** person's `mri`. Distinct
  people would carry distinct mris — so merge by shared mri, never by adjacency alone.
- AMS images come either with `width`/`height` attrs OR with `style="width:1080px; height:1363px"` and
  no attrs. The style-only ones had 0 reserved height → the shift.

## What shipped

- **`core/teams-render.js`** — `renderBody` builds an itemid→mri map from `properties.mentions` and
  passes it to `resolveMentions(html, mentionMri)`, which replaces each Mention span with a sentinel
  keyed by its person (mri, else `id:{itemid}`), collapses runs of adjacent same-key sentinels (only
  whitespace/`&nbsp;` between) into one, then emits one `<span class="mention">@{joined}</span>`.
  Different mris never merge; legacy `<at>` unchanged; no `mentions` prop → no merge (safe).
- **`core/teams-media.js`** — `ensureMediaDimensions(html)` (called from `rewriteMediaHtml`): for an
  `<img>`/`<video>` lacking both `width`/`height` attrs but with `style="width:Npx;height:Npx"`, copy
  those numbers to real `width`/`height` attrs (a `max-width`/`min-height` lookbehind guard avoids
  false matches). The browser then reserves an aspect-ratio box before load.
- **`chat/src/index.css`** — non-emoji/sticker `img`/`video` get a `var(--muted)` **placeholder box**
  (the generic placeholder; blurHash deferred — `properties.blurHash` exists for a real blur later);
  emoji/sticker opt out. `height:auto` + the max-height cap keep the reserved box stable across load.
- **`chat/src/lib/sanitize-message.ts`** — no change (width/height already allowed; `style` stays
  stripped — that's why the dimensions are converted to attrs upstream).

## Acceptance criteria

- [x] A per-token-split mention renders as ONE pill with the full name; two distinct adjacent people
      stay two pills. (Live: "@Glory Nguyen - Group Office [C]" = 1 pill.)
- [x] Every media element has reserved dimensions (width/height attrs) + a placeholder → no content
      shift when the bytes load. (Live: the style-only image now `1170×2532`, aspect reserved.)

## Test plan

- **Layer 1 (TDD)**: `resolveMentions` merge (6-span same-mri → 1 pill; two distinct → 2; single;
  `<at>`; no-prop → no merge). `ensureMediaDimensions` (style→attrs; existing attrs kept; neither;
  decimals; max-/min- guard; composes with the src-rewrite).
- **Layer 2/3 (live, orchestrator)**: mention one-pill + image reserved dimensions — both verified.

## Definition of Done

- [x] Layer 1 green (1245 tests). typecheck / biome (touched) / chat build / `node --check` clean.
- [x] Live-verified. CLAUDE.md updated. No AI attribution.
- [x] Task → done, `t118` in commit.

## Notes

- Worktree: docs on `main`, code on feature branch (2-commit ship); `--no-verify`; never `git add -A`.
- Sentinels use Private-Use-Area chars built at runtime (dodge Biome `noControlCharactersInRegex`).
