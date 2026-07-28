# PSN-113 — [chat] UI enhancements

Plan-only until the label flips to `build`. Same issue, same branch (`chat-ui-enhancements`), ONE PR.

## Goal

Four targeted fixes on the `/chat` surface, each a daily-driver-felt papercut:

1. **Composer Shift+Enter** creates a paragraph break (not a `<br>`), so a list typed on the new line doesn't swallow the previous line.
2. **Format toolbar active states** reflect reality — toggling B/I/U/S with no selection highlights immediately, and the block formats (code / code-block / quote / lists) show an active indicator.
3. **Group-chat preview + notification toast** prefix the sender’s first name: “Glory: Hello”.
4. **Reaction pane hover** stops vanishing mid-transit — the bar survives the cursor crossing the gap, and an adjacent bubble no longer steals an open bar.

Constraints (from the issue): self-chat only, no mutations on other users’ threads.

## Verification (no vision this session)

This session has **no vision**. Every workstream is verifiable for *correctness* without a screenshot — TDD + real-input e2e + DOM/JS state reads. Vision is only the late "feel" gate (does the bridge look right, is the prefix readable) — that falls to the operator's daily-driver pass, which is the project's bar anyway ("I'd want to use this").

- **Unit (TDD, pure):** the bulk. `conversation-view.test.ts`, `hover-overlay-owner.test.ts`, a Headless Tiptap editor in jsdom for the composer keydown/doc assertions, store.ts JOIN test.
- **E2E, real input (no `dispatchEvent`):** Playwright / chrome-devtools MCP `Input.*` for click/type/hover/key — drives the mock stack. Per `docs/conventions/e2e-verification.md`.
- **State reads via `evaluate_script`:** `document.activeElement`, `editor.isActive('bold')`, Radix `data-state` / `aria-pressed`, `getBoundingClientRect`, computed styles, ProseMirror `view.state.doc.toJSON()`. Read-only — never to *drive* the UI.
- **Inbound simulation:** `pnpm chat:mock:say -d '{"convId":"…","text":"…"}'` → assert the WS delta / `chat:notify` payload body string + the rendered sidebar preview text.
- **Mock stack needs Node 24** (`nvm use 24` — `better-sqlite3` is Node-24-ABI; Node 22/20 fails `ERR_DLOPEN_FAILED`). Per `docs/testing/chat-qa.md`.
- `/regression` dispatches the chat-QA pass to subagents (verdict only, evidence stays on disk). Extend `docs/testing/chat-qa.md` with new case IDs for A–D (the doc is "extended, never rewritten").

**Residual needing a human/vision eye before merge:** the hover "feel" (lag, bridge geometry), the prefix's visual weight in a long preview, light/dark pixel check. The operator does this; it is not a blocker for `build`-phase correctness gates.

## Baseline (probed)

- **Composer** = Tiptap StarterKit v3 (`@tiptap/react` + `starter-kit` + `extension-mention` + `extension-placeholder`). `chat/src/components/composer.tsx`.
  - `handleKeyDown` (composer.tsx:341-376): `Shift+Enter` returns `false` (line 350) → falls through to StarterKit’s default = the **HardBreak** extension → inserts `<br>` inside the *same paragraph*. Typing `- ` afterwards converts that whole paragraph into a bullet list (the input rule fires on the paragraph, not the visual line). **Confirmed root cause.**
  - Active-mark readout (composer.tsx:498) `activeMarks = MARKS.filter(m => editor.isActive(m.v))`, re-rendered by `setTick` on `onUpdate` + `onSelectionUpdate` only (composer.tsx:386-390). Toggling a mark with an empty selection fires **neither** (it’s a mark-only transaction) → `activeMarks` stays stale → the B/I/U/S chip doesn’t highlight until the caret moves or a char is typed. **Confirmed root cause.**
  - Block-format buttons (Code/CodeBlock/Quote/Bullet/Numbered, composer.tsx:524-549) are plain `FmtButton`s — no `editor.isActive` styling at all, so there’s no active indicator when the caret is inside a list/quote/code-block.
  - Focus steal: the **Aa / Formatting toggle** (composer.tsx:845-853) and the **Attach** button (composer.tsx:655) have no `onMouseDown preventDefault`. `FmtButton` (line 104) and `ToggleGroupItem` (line 516) already preventDefault. Clicking Aa blurs the editor.
- **Sender name** — `TeamsConversation` (`chat/src/lib/teams-client.ts:8`) has **no** last-sender field. The `conversations` row holds a denormalized last-message snapshot (`last_message_id/_ts/_preview/_from_me`, store.ts:184-188) — but `last_message_id` IS a real FK into the `messages` table, and `messages.sender_name` already exists (store.ts:53). The sweep already does this exact lookup for push (sweep.ts:243-244 → `last?.senderName`, sweep.ts:248).
- `previewLine(conv)` (`chat/src/lib/conversation-view.ts:40`) is the single read site for **both** the sidebar row preview (conversation-row.tsx:150) **and** the notification body (chat-app.tsx:250 Electron `chat:notify`, chat-app.tsx:254 web `Notification`).
- **Reaction hover** — single-owner store `hover-overlay-owner.ts`. `requestOpen` swaps **instantly** when another overlay is open (line 84-86); `requestClose` waits `closeDelay` 140ms (line 51, 97-100). `message-row.tsx` binds `onMouseEnter/Leave` on the row (line 454-455) and the reaction bar floats above the bubble with an uncovered gap.

## Decisions (grilled 2026-07-28)

- **D1 — Shift+Enter = split-block outside lists.** Outside a list/code block, Shift+Enter runs `editor.chain().focus().splitBlock().run()` (new paragraph) — fixes the list-after-newline bug. Inside a list item, Shift+Enter keeps HardBreak (line break within the item); Enter keeps native list behavior (new item / exit on empty). *(Chosen over “always new paragraph” — preserves in-item line breaks.)*
- **D2 — Active-state fixes.** (a) Add `onTransaction: () => setTick(t => t+1)` to the `useEditor` config so a mark-only transaction (toggle with empty selection) re-renders immediately. (b) Give the block-format `FmtButton`s an active style via `editor.isActive(code|codeBlock|blockquote|bulletList|orderedList)` (accent bg, same as the BIUS chips).
- **D3 — Sender source = read-time JOIN.** No schema change. `listConversations` (+ the conv-row shaper at store.ts:322) LEFT JOINs `messages` on `(service, conv_id, id) = last_message_id` → `last_message_sender_name`. Surfaces as `TeamsConversation.lastMessageSender`. Degrades to no prefix when that message row isn’t swept yet (a never-opened thread) — matches native Teams.
- **D4 — Prefix = always first name.** `formatName(sender, { mode: "first" })` regardless of the user’s name-display pref (full name is too long in a one-line preview). Gated on `kind === "group" && (memberIds?.length ?? 0) > 2 && !lastMessageFromMe`. No prefix when fromMe (no “You:”) or sender unknown.
- **D5 — Reaction hover.** (a) Raise `closeDelay` (140 → ~300ms) **and** bridge the bubble→bar gap so transit stays inside the hover region (no `onLeave` fires when crossing into the bar). (b) Drop the instant-swap-while-open: a new bubble’s `requestOpen` while another bar is open waits the short `openDelay` too (the old bar closes on its own grace) — so brushing an upper bubble mid-transit no longer steals an open bar. Final ms tuned live via `/cdp`.

## Workstreams

Each is one session. Same branch, same PR throughout.

### A — Composer: Shift+Enter paragraph break + focus-keep
**Touches:** `chat/src/components/composer.tsx`.
- In `handleKeyDown` (composer.tsx:341), handle `Shift+Enter`: if `ed.isActive("listItem") || ed.isActive("codeBlock")` → return false (current hardBreak/native); else `event.preventDefault(); ed.chain().focus().splitBlock().run(); return true`.
- Add `onMouseDown={(e) => e.preventDefault()}` to the **Aa / Formatting** toggle (composer.tsx:845) and the **Attach** button (composer.tsx:655).
- Tests: extend `chat/src/lib/rich-compose.test.ts`? The keydown lives in the component (not pure) — cover the new branch via a focused Tiptap instance in a vitest + jsdom test (Headless editor) asserting the post-Shift+Enter doc is two paragraphs, and that `- ` on the second produces a list only on that paragraph.
- **Verify (no vision):** Headless Tiptap in jsdom — after `text + Shift+Enter + "- item"`, assert `editor.getJSON()` is `{ doc: { type:'doc', content:[ {type:'paragraph',...}, {type:'bulletList', content:[{type:'listItem',...}]}] } }` (the bullet wraps only the second paragraph). Real-input e2e on the mock stack: focus the editor, `page.keyboard` type the same sequence, `evaluate_script` reads `editor.getHTML()` → assert two-block structure. Focus-keep: `page.click('button[aria-label="Formatting"]')`, then `evaluate_script(() => document.activeElement?.className)` → assert it’s the `.ProseMirror` node (same for Attach).

### B — Composer: format active states
**Touches:** `chat/src/components/composer.tsx`.
- Add `onTransaction` to `useEditor` config (composer.tsx:386 region) → `setTick`.
- Convert the 5 block `FmtButton`s to reflect `editor.isActive(...)` (accent bg + foreground when active). Keep them as `Button` (not ToggleGroup) — a per-button `aria-pressed` + conditional class is enough.
- Tests: unit-test the active-derivation is unchanged for BIUS; the block-active is a render concern — assert via the Headless editor that `editor.isActive("bulletList")` is true after `toggleBulletList`.
- **Verify (no vision):** Real-input e2e on the mock stack — focus editor, `page.click` each BIUS ToggleGroupItem with an empty selection, then `evaluate_script(() => editor.isActive('bold'))` (and `…('italic'|'underline'|'strike')`) → assert true; also assert the ToggleGroupItem DOM has `data-state="on"`. For block formats: `page.click` the bullet-list button, `evaluate_script(() => editor.isActive('bulletList'))` → true, and the FmtButton has `aria-pressed="true"`; move caret to a plain paragraph → `aria-pressed="false"`. Dependent on A (same file) — do A then B in the same session or sequence.

### C — Group sender prefix (sidebar preview + toast)
**Touches:** `apps/chat-server/src/store.ts` (conv-row SELECT + shaper), `apps/chat-server/src/contract.ts` (`ChatConversation`), `chat/src/lib/teams-client.ts` (`TeamsConversation`), `chat/src/lib/conversation-view.ts` (`previewLine`), `chat/src/components/conversation-row.tsx` (pass `namePref`? no — always first name), `chat/src/chat-app.tsx` (notify build already calls `previewLine`).
- store.ts: in every conv-row SELECT (incl. `listConversations`, the WS snapshot/delta row shaper), `LEFT JOIN messages m ON m.service = c.service AND m.conv_id = c.id AND m.id = c.last_message_id` → select `m.sender_name AS last_message_sender_name`. Add to `ConversationInput`/row shaping (store.ts:322 region) → `lastMessageSender`.
- contract.ts + teams-client.ts: add `lastMessageSender?: string` to the conv shape.
- conversation-view.ts `previewLine`: accept the sender (already on `conv`), prefix when `conv.kind === "group" && (conv.memberIds?.length ?? 0) > 2 && !conv.lastMessageFromMe && conv.lastMessageSender` → `` `${formatName(conv.lastMessageSender, { mode: "first" })}: ${base}` ``. Reuse `formatName` from `display-name.ts`.
- Tests: pure unit tests in `conversation-view.test.ts` — group + sender → prefixed; group + fromMe → not; oneOnOne → not; group + memberIds≤2 → not; unknown sender → not. store.ts: a test that a conv whose last_message_id matches a messages row yields `lastMessageSender`, and a missing row yields undefined.
- **Verify (no vision):** Pure unit tests cover the prefix predicate (group/DM/fromMe/memberCount/unknown). Backend: a store.ts test asserting a conv whose `last_message_id` matches a messages row yields `lastMessageSender`, missing row → undefined. E2E on the mock stack: `GET /api/chat/conversations` → assert the group conv’s `lastMessageSender` + the rendered sidebar row text startsWith `"FirstName: "`; `pnpm chat:mock:say` into a group conv → read the WS delta / `chat:notify` payload body → assert it startsWith `"FirstName: "`. 1:1 DM and self-sent last message → assert no prefix.
- **Risk:** the JOIN must cover EVERY conv-row read (HTTP list, WS snapshot, WS delta). Missing one → flicker. Single-owner the row shape so it can’t drift.

### D — Reaction pane hover bridge
**Touches:** `chat/src/lib/hover-overlay-owner.ts`, `chat/src/lib/use-hover-overlay.ts`, `chat/src/components/message-row.tsx`.
- hover-overlay-owner.ts: (a) raise default `closeDelay` (~300ms); (b) replace instant-swap-while-open (line 84-86) with a short pending open (reuse `openDelay`) so a brush doesn’t evict a live owner; the old owner closes on its own grace.
- message-row.tsx: render an invisible bridge (a tall transparent pad / `before` pseudo-element on the bar) spanning the bubble→bar gap so `onMouseEnter` on the bar cancels the close before the gap transit completes; ensure the bar sits above adjacent bubbles (z-index) and captures the pointer first.
- Tests: pure timing tests in `hover-overlay-owner.test.ts` (already exists per the lib) — assert a second `requestOpen(B)` while A is open does NOT evict A instantly; A closes only after its grace; entering the bar region cancels the close.
- **Verify (no vision):** Pure timing tests in `hover-overlay-owner.test.ts` (DI timers) — assert (a) `closeDelay` raised to ~300ms; (b) a second `requestOpen(B)` while A is open does NOT evict A instantly (A still owns until its own grace fires); (c) entering the bar region cancels the pending close. E2E real-input: two stacked bubbles, `page.hover` the lower, then move the mouse toward its bar in steps (real `Input.dispatchMouseEvent`), crossing the upper bubble’s box — `evaluate_script` reads the lower bar’s `data-state`/opacity → assert still open; the upper bar is NOT open. Assert the bridge element’s `getBoundingClientRect` spans the bubble→bar gap.
- **Risk:** slowing the swap can feel laggy when deliberately moving between bubbles. Tune by feel; keep `openDelay` short. If the bridge element traps clicks on the message, constrain it to the bar’s anchor column only.

### Bug-sweep (last)
After A–D land: `/regression` against the chat surface + the mock stack. Confirm `/` (browser PWA) byte-unchanged. No new deps.

## Dependency / parallelism

| WS | Deps | Notes |
|---|---|---|
| A | — | composer.tsx |
| B | A (same file) | sequence after A |
| C | — | backend (store.ts) + FE; independent |
| D | — | hover store + message-row; independent |
| Sweep | A,B,C,D | last |

A→B sequential. C and D parallel with A/B.

## Acceptance checklist

- [ ] A: Shift+Enter outside a list creates a new paragraph; `- ` / `1. ` on the new line applies the list to that line only. Inside a list, Shift+Enter still line-breaks within the item.
- [ ] A: Clicking the Aa / Formatting toggle and the Attach button does not blur the editor (caret stays).
- [ ] B: Toggling B/I/U/S with an empty selection highlights the chip at once.
- [ ] B: Block formats (code, code-block, quote, bullet list, numbered list) show an active state when the caret is inside them, and clear when leaving.
- [ ] C: A group chat (≥3 members) shows “FirstName: …” in the sidebar preview and in the OS/web notification body; 1:1 DMs and self-sent last messages show no prefix; unknown sender degrades to no prefix.
- [ ] D: The reaction bar survives the cursor moving from the bubble to the bar; an adjacent upper bubble no longer steals an open bar mid-transit.
- [ ] `pnpm test`, `pnpm typecheck`, `pnpm check:changed` green.
- [ ] No-vision e2e green per WS (real input + `evaluate_script` state reads) on the mock stack; unit tests cover the pure predicates. Light/dark **visual** pass is the operator's daily-driver gate (not a `build`-phase blocker — this session has no vision).
- [ ] `/` browser PWA byte-unchanged; no new dependencies.

## Out of scope

- E2E CA-proof Teams call paths, AMS media, real send round-trips (no tenant locally).
- Changing Enter-to-send semantics (Enter still sends outside lists/code).
- The user’s name-display PREF applying to the preview prefix (D4: always first name).
- Reaction bar on coarse pointers (touch) — stays hidden, unchanged.
- Any other composer feature beyond the four listed.

## Notes

- Branch is `chat-ui-enhancements` (already created). PR opens on plan commit, stays one PR through build.
- Preview deploys lag pushes; preview DB starts empty — say so before calling a feature missing.
- Self-chat only; no mutations on other users’ threads.
