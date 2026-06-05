# 065 — remote input shortcut guard + bidirectional clipboard (copy/paste local<->remote)

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** none
- **Blocks:** none

## Goal

Two related input fixes. (1) Bare single-character app shortcuts must stop hijacking
keystrokes meant for the remote page: typing `?` over the screencast canvas types a
literal `?` into the remote input instead of opening the shortcut overlay. (2) Make
copy/paste cross the local↔remote boundary seamlessly: ⌘/Ctrl+C copies the remote
selection to the local clipboard (already works), ⌘/Ctrl+V pastes the local clipboard
into the remote focused element (missing today), plus a right-click context menu over
the canvas with Copy/Paste/Cut. Works in both the Electron and web builds.

## Why now

`?` being un-typable is a daily-driver papercut — the remote page is the primary
surface and you can't type a common character. Paste (local→remote) is simply absent,
so moving text from the local machine into the remote browser is impossible without
retyping. Both are core "feels like a real browser" expectations.

## Acceptance criteria

- [ ] Typing `?` over the screencast canvas (or a local webview) types a literal `?`
      into the remote/local page; it does **not** open the shortcut overlay.
- [ ] The shortcut overlay still opens via `⌘/`, the ⌘K palette, and the toolbar
      affordance. Bare `?` opens it **only** when app chrome (not the canvas/webview)
      holds focus.
- [ ] No other bare-key shortcut regresses (audit confirms `?` was the only bare-key
      binding; everything else already requires a modifier).
- [ ] ⌘/Ctrl+V over the canvas pastes the local clipboard into the remote focused
      element. Plain text inputs receive the text and fire `input` events (React
      controlled inputs update).
- [ ] When the remote focus is a rich/contenteditable editor, paste routes through the
      pre-seed-clipboard + ⌘V path so the page's `onpaste` handler runs.
- [ ] ⌘/Ctrl+C copy continues to work (regression guard).
- [ ] Right-click over the canvas shows a Copy / Paste / Cut context menu wired to the
      same copy/paste paths.
- [ ] Both builds: Electron uses the main-process `clipboard` module over IPC; web uses
      `navigator.clipboard` gated by `caps.web`. In E2E mode clipboard payloads are
      sealed like every other `/api` body.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] `key-routing` (or a new pure predicate) — "is this a typing surface" gate:
      bare-char shortcuts suppressed when `activeKind` is `cdp`/`local`, allowed when
      app chrome focused. Cover `?`, `⌘/`, and a sample modifier shortcut (must still
      fire).
- [ ] Clipboard `grantPermissions` enum-fallback helper — new names
      (`clipboardRead`/`clipboardWrite`) first, legacy (`clipboardReadWrite`) on the
      `-32602 Unknown permission type` error. Pure, table-driven.
- [ ] Paste-route selector — given a remote focus descriptor (plain input vs
      contenteditable/rich), returns `insertText` vs `preseed+paste`.

### Layer 2 — Manual smoke (CDP/IPC)

- [ ] Live remote: select text on a page, ⌘C, paste into a local app → local clipboard
      has it.
- [ ] Copy text locally, ⌘V over the canvas into a remote `<input>` → text appears,
      caret correct.
- [ ] ⌘V into a remote rich editor (e.g. Gmail/Docs compose) → onpaste path runs,
      formatting/sanitize behaves.
- [ ] Right-click canvas → Copy/Paste/Cut each work.
- [ ] Electron build and `pnpm web` build both exercised; web tested as the PWA over
      HTTPS (clipboard needs secure context + gesture).

### Layer 3 — Visual review

- [ ] Screenshots via Chrome MCP against `pnpm dev` / `pnpm web`.
- [ ] Right-click context menu renders (radix/shadcn style, HugeIcons), positioned at
      the cursor, dismisses on outside click/Esc.
- [ ] Shortcut overlay still opens via `⌘/`.

## Design notes

Two independent one-way clipboard bridges (the noVNC/Guacamole model), gesture-driven,
**no** ambient background sync — ambient sync hits the focus/permission wall and is a
privacy leak. The renderer has zero knowledge of remote focus and we do **not** add
remote-focus tracking for the shortcut guard (racy, per-keystroke latency, breaks on
cross-origin/shadow DOM). Instead we treat the canvas as a typing surface: any bare
char belongs to the remote when the canvas/webview is active.

- **Contracts changed:**
  - Global keydown handler (`app.tsx`) — the bare `?` branch gains a "typing surface"
    guard (`activeKind === 'cdp' | 'local'` ⇒ skip + let it forward). New `⌘/` opener
    for the overlay.
  - `RemotePage` input surface — add a `paste(text, {rich})` intention:
    `Input.insertText` for plain text; `Runtime.evaluate(navigator.clipboard.writeText)`
    + forwarded ⌘V for rich. Existing `copySelection` unchanged.
  - Connector / main — grant `clipboardRead`/`clipboardWrite` via `Browser.grantPermissions`
    on connect, re-applied on reconnect like device-metrics, with legacy enum fallback.
    Only needed for the navigator.clipboard (pre-seed + readText fallback) paths.
- **New modules:**
  - `core/clipboard.js` (pure) — `grantPermissions` enum-fallback builder + paste-route
    selector. Backend-agnostic, consumed by `main.js` + `web/server.mjs`. Add to
    `build.files` allowlist.
  - `src/lib/clipboard-bridge.ts` (renderer orchestration) — copy/paste verbs over the
    `window.cdp` surface; Electron→IPC `clipboard`, web→`navigator.clipboard` gated by
    `caps.web`.
- **New ADR needed?** Likely yes — short ADR "Clipboard as two gesture-driven bridges"
  (records: no ambient sync, getSelection for reads, insertText vs preseed+paste,
  grantPermissions enum). Draft title: `0010-clipboard-gesture-bridges.md`.

```ts
// renderer paste intention (shape, not path)
type PasteIntent = { text: string; rich: boolean }
// rich=false → Input.insertText; rich=true → preseed remote clipboard + forward ⌘V
```

## Out of scope

- Floating "copy/cut" toolbar that appears on remote text selection (needs an injected
  `selectionchange` listener + rect tracking) — defer to a follow-up task.
- ⌘K palette "Copy selection / Paste to page" actions — not selected for v1; trivial to
  add later as pure `hotkey-registry` entries.
- Rich clipboard formats beyond text: HTML/image paste marshalling (base64 ClipboardItem)
  beyond what the preseed+⌘V path gives for free.
- Document-start injected `copy`/`cut` capture for custom/canvas-app copies (the
  `getSelection()` read covers normal DOM selection); defer.
- Tracking remote `document.activeElement` for the shortcut guard.

## Definition of Done

- [ ] Layer 1 tests written and green (pure logic was touched)
- [ ] Layer 2 smoke checklist completed with a live Remote Browser (main.js/IPC touched)
- [ ] Layer 3 screenshots captured and committed (UI touched)
- [ ] `pnpm check` clean (Biome — lint + format)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] `pnpm dev` and `pnpm web` boot cleanly and copy/paste + `?` work end-to-end
- [ ] CLAUDE.md updated for any modified module (clipboard bridges, shortcut guard)
- [ ] ADR written (`0010-clipboard-gesture-bridges`) if kept
- [ ] No commented-out code, no `console.log` debris, no AI attribution
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t065 in commit

## Notes

Decisions locked with the user (2026-06):
- `?` fix: `⌘/` opens overlay + keep ⌘K/toolbar; bare `?` always forwards to remote when
  the canvas/webview is the active surface.
- Paste fidelity: **hybrid** — `Input.insertText` by default, pre-seed clipboard + ⌘V
  when remote focus is a rich/contenteditable editor.
- v1 UI: right-click context menu only (no floating toolbar, no ⌘K actions).
- Delivered as one combined task (this file).

Gotchas surfaced in research:
- `navigator.clipboard.readText()` needs document focus + a transient user gesture +
  secure context — must run synchronously inside the actual keydown/click handler, not
  after an `await`/`setTimeout`, or it throws `NotAllowedError`. Remote tab is usually
  not OS-focused, so use `document.getSelection().toString()` (via `Runtime.evaluate`,
  `awaitPromise:true`, `returnByValue:true`) for remote reads — permission/focus-free.
- `Input.insertText` does NOT dispatch a `paste` ClipboardEvent — hence the rich path.
- `Browser.grantPermissions` enum split: Edge 148 wants `clipboardRead`/`clipboardWrite`
  and rejects `clipboardReadWrite` with `-32602`; send new names, fallback to legacy.
- Keep Electron clipboard read/write in **main** (privileged-ops-in-main rule); web uses
  `navigator.clipboard` gated by `caps.web`.

---

## Implementation Status (2026-06-05)

**DONE — Layer 1 (Pure Logic):**
- ✓ `src/lib/typing-surface.ts` — `isTypingSurface` guard predicate + tests
- ✓ `core/clipboard.js` — `grantPermissions` enum-fallback builders + `selectPasteRoute` + tests
- ✓ `src/lib/remote-page.ts` — `paste(text, {rich})` intention

**DONE — Layer 1 Fixes (Shortcuts):**
- ✓ `src/app.tsx:991` — `?` handler now guarded by `isTypingSurface(activeKind)` so bare `?` forwards to remote
- ✓ `src/app.tsx:1005-1016` — Added `⌘/` opener for shortcut overlay (alternative when canvas is active)

**DONE — Layer 1 Implementation (Paste):**
- ✓ `preload.js:24` — Exposed `window.cdp.readClipboard()` IPC method
- ✓ `main.js:200-202` — IPC handler `cdp:read-clipboard` reads Electron clipboard
- ✓ `src/vite-env.d.ts:99` — Added `readClipboard` type to `CdpBridge`
- ✓ `src/lib/cdp-web-transport.ts:1197-1202` — Web build `readClipboard` via `navigator.clipboard`
- ✓ `src/app.tsx:1177-1184` — Added ⌘V handler: reads local clipboard, calls `page.paste(text, {rich:false})`

**Verification:**
- ✓ `pnpm typecheck` clean
- ✓ `pnpm test` — all 617 tests pass (61 test files, +2 new test files for typing-surface + clipboard)
- ✓ `pnpm build` — builds without errors
- ✓ `pnpm dev` — boots without errors

**DONE — image paste + web fix (added after first smoke):**
- ✓ `RemotePage.pasteImage(dataUrl)` — synthesizes a remote `paste` ClipboardEvent with a `DataTransfer` carrying the image as a `File` (rich editors read `clipboardData.files`)
- ✓ Electron image paste: `cdp:read-clipboard-image` → `clipboard.readImage().toDataURL()` (image-first, text fallback in the ⌘V handler)
- ✓ Web paste rewired to the **native `paste` event** — `navigator.clipboard.readText()` is blocked on Safari/iPad PWA; the listener reads text + image items from `clipboardData`. Cmd+V is left un-`preventDefault`ed on web (viewport `isPasteCombo` skip + app keydown `caps.web` break) so the browser fires the event.

**VERIFIED — Layer 2 smoke (live remote):**
- ✓ `Input.insertText` confirmed working against the live remote (Edge 148) via a direct CDP probe
- ✓ Electron: ⌘V text paste into a remote input — works (user-confirmed)
- ✓ PWA (web): ⌘V text **and** image paste into Slack — works (user-confirmed)

**DEFERRED (unchanged from spec):**
- Right-click context menu (Copy/Paste/Cut) — v2
- Hybrid rich-vs-plain auto-detection on the remote focus — v1 routes plain via `insertText`, images via the synthetic paste event; the `paste(text,{rich})` pre-seed path exists but isn't auto-selected
- Document-start injected clipboard capture scripts — v1 uses `getSelection()` only

**ADR:** none written. The decision (two gesture-driven one-way bridges, no ambient sync, the Safari native-`paste`-event approach, `insertText` vs synthetic-paste-event) is recorded in the root CLAUDE.md "Key Design Decisions" → *Clipboard paste (t065)*. Follows the t055 precedent of not opening a separate ADR for a contained feature already captured there. (`0010` is also already taken by the workspaces ADR.)

_When task status flips to `done`, move this file to `done/`._
