# 111 — teams chat rich-HTML message render (DOMPurify sanitized subset)

- **Status:** done
- **Mode:** HITL
- **Depends on:** t107 (thread + teams-render), t109 (names)
- **Blocks:** UI polish

## Goal

Thread messages render **rich** — bold/italic/underline, links, `@mentions`, emoji, code,
lists, quotes — instead of today's plain text. This is the Q6 full-fidelity decision.
Teams `content` is site-authored HTML, so this is security-critical: the client sanitizes
with **DOMPurify** (strict allowlist) before any `dangerouslySetInnerHTML`. Per the chat-ui
research: DOMPurify is browser-native (no jsdom), so it runs in the renderer, not the
server core.

## Scope

- Add **`dompurify`** (`pnpm add dompurify` at repo root — v3 self-typed, do NOT add the
  deprecated `@types/dompurify`).
- **`core/teams-render.js`** (server): change the message `body` from plain-text-stripped to
  **mention-resolved, entity-intact HTML** (resolve `<at id=…>Name</at>`/`<span itemtype=…>`
  to a stable mention markup e.g. `<span class="mention">@Name</span>`; keep the rest of the
  Teams HTML; DO decode nothing that would create tags). Cards/attachments still degrade to a
  `[card]` chip (t112 renders them). Keep the separate plain-text **`previewLine`** for the
  conversation-list preview (previews stay plain — no rich). Update the TDD.
- **`chat/src/lib/sanitize-message.ts`** (renderer, TDD-able with a jsdom-free unit via
  DOMPurify's `isSupported` guard, else covered visually): one memoized configured DOMPurify
  instance. **Allowlist** tags `b strong i em u s a code pre kbd ul ol li blockquote br p span
  img` + attrs `href title class src alt`; **forbid** everything else (script/style/iframe/
  event-handlers). `afterSanitizeAttributes` hook: on `<a>` force `target="_blank"
  rel="noopener noreferrer"` and allow only `http(s)/mailto` hrefs; keep emoji `<img>` (cap
  size, `loading="lazy"`); keep the mention `<span class="mention">`. Export `sanitize(html)`
  → safe HTML string.
- **`chat/src/components/message-row.tsx`**: render `m.body` via
  `dangerouslySetInnerHTML={{ __html: sanitize(m.body) }}` — **always** through `sanitize`,
  never raw. Style mentions (`.mention` — subtle highlight), links (underline/accent), code
  (mono/bg) via the message CSS. Emoji/inline `<img>` constrained to line height (a big
  inline image → capped or a link; Teams content images are auth-gated and may 404 — that's
  acceptable, they degrade to alt text).

## Acceptance criteria

- [ ] Bold/italic/links/@mentions/emoji/code/lists/quotes render in the thread.
- [ ] EVERY message body passes through `sanitize` before `dangerouslySetInnerHTML`; a
      `<script>`/`onerror=`/`javascript:` in the content is stripped (no execution) — TDD/xss cases.
- [ ] Links open in a new tab with `rel="noopener noreferrer"`; non-http(s)/mailto hrefs dropped.
- [ ] Conversation-list previews stay plain text (no markup leaks into the row).
- [ ] `dompurify` added to `dependencies` (v3), builds clean.

## Test plan

- **Layer 1 (TDD):** `teams-render` body now emits mention-resolved HTML (mention markup,
  entity handling, card→chip) + `previewLine` still plain. `sanitize-message` XSS cases
  (script/style/onerror/javascript: stripped; allowed tags kept; link hardening) — DOMPurify
  runs in jsdom under Vitest (add jsdom env for that test file if needed) OR assert the config.
- **Layer 3 (visual, REQUIRED):** thread rendering a message with bold + a link + an
  @mention + an emoji + a code span; confirm formatting shows and nothing executes.

## Design notes

- Server passes untrusted HTML; the CLIENT sanitize is the security boundary — message-row
  must NEVER render `m.body` without `sanitize`. Keep that invariant loud in the code.
- previewLine stays the plain-text reducer (list rows + notifications want no markup).
- Covered by ADR-0018; note the DOMPurify adoption (research trigger #1 reached).

## Out of scope

- Adaptive cards render (t112 — still a chip). Attachments/file previews (t111-ish? no —
  later). Link unfurling/previews. Markdown (Teams is HTML, not markdown).

## Definition of Done

- [ ] Layer 1 green (incl. XSS cases); Layer 3 rich-render screenshot.
- [ ] `pnpm check`(touched)/`typecheck`/`test`/`chat:build`/`/` build unchanged.
- [ ] CLAUDE.md updated (rich render + DOMPurify boundary). No AI attribution / console debris.
- [ ] Task → done, moved to `done/`, `t111` in commit.

## Notes

- Worktree: docs on main, code on feature branch (2-commit ship); never `git add -A`;
  `--no-verify` (rtk breaks pre-commit). DOMPurify v3 is self-typed (no @types stub).
