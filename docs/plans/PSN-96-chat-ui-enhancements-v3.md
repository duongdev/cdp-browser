# PSN-96 — Chat UI enhancements v3 (plan)

Status: grilled — decisions resolved · plan-only · 2026-07-24
Issue: https://linear.app/withdustin/issue/PSN-96

Part 3 of the `/chat` polish epic (part 1 = PSN-90, part 2 = PSN-95). Scope:
unread-jump FAB, keyboard rework (⌘[/⌘], `/`), reactions revamp with a full
emoji picker, URL hover-copy, a shared prompt dialog replacing `window.prompt`,
lightbox close button, folder drag-and-drop, multi-file attachments, reply-quote
bubble styling, cross-device sidebar sync, settings polish, and a ⌘K command
enrichment pass. Each workstream is sized for one session.

## Baseline (probed 2026-07-24, code audit)

- **Unread separator**: exists (`NewSeparator`, `thread-view.tsx:1052`;
  `buildThreadItems` in `chat/src/lib/thread-group.ts`). No jump affordance —
  only the scroll-to-bottom FAB (`thread-view.tsx:1006`). Threads open at
  bottom (`flex-col-reverse`).
- **Settings sheet** (`chat/src/components/settings-sheet.tsx`): server-URL
  Save button (`size="sm"`, ~line 320) renders shorter than its input
  (`py-1.5`). Notifications toggle exists (`notify-toggle.tsx`) but is gated by
  `pushCapable()` — web-push only, so the **Electron shell has no toggle** and
  its `chat:notify` path is ungated.
- **Keyboard** (`chat/src/lib/chat-keys.ts` `routeKey`): opt+↑/↓ = conv
  prev/next but guarded by `!ctx.composerFocused`; no ⌘[/⌘], no `/`. `i`
  focuses composer (thread only).
- **Reactions** (`message-row.tsx:395`): hover reveals the action cluster, a
  second click opens the 6-emoji quick bar — 2 steps. No picker lib, no custom
  emoji. Optimistic overlay + poll reconcile already solid (t142/t143).
- **Links/chips**: sanitizer forces `target=_blank` on `<a>`; no copy
  affordance anywhere. File chips link out to SharePoint `shareUrl`; recording
  chips to playback URL (t162).
- **Native prompts**: `window.prompt` at `chat-app.tsx:548` (rename) and
  `:564` (move-to-folder) — **broken on Electron** (prompt is a no-op there).
  Label input flows through the same pattern. shadcn `Dialog`/`AlertDialog`
  primitives already in use elsewhere.
- **Lightbox** (`image-lightbox.tsx`): **no X button at all** — Esc /
  click-outside only. Fixed overlay with no titlebar offset; on Electron the
  frameless drag region (`.is-electron .titlebar`, top 48px) sits above it, so
  any top-strip control would be drag-captured.
- **Folders**: alpha-sorted sections (`conversation-list.tsx:362`
  `FolderSection`); collapse state per-device in ui-state
  (`use-conv-prefs.ts`). No DnD anywhere in `chat/src`; dnd-kit installed at
  repo root and proven in the CDP sidebar (`src/components/sidebar.tsx`).
- **Attachments**: single `pendingFile: File | null` (`composer.tsx:78`);
  non-image file send exists (SharePoint path); images via AMS (t145). Send
  icon is `SentIcon` (paper-plane), `composer.tsx:409`.
- **Reply quote**: composer chips are colorful (author-accented); the
  blockquote inside a sent bubble renders as a plain sanitized `blockquote` —
  visually flat. Dismissing a composer quote does not restore focus.
- **Prefs sync**: `conversation_prefs` (folders/labels/renames/mutes) fetched
  on boot + after own writes only — another device's change needs a manual
  refresh. The t103 pins-sync pattern (poll-cadence re-fetch + change-detect +
  post-write grace) is the in-repo reference.
- **⌘K palette**: exists (`command-registry.ts`), context-aware; covers nav,
  read-toggle, settings-open — but no settings toggles, no conversation
  management verbs, none of this epic's new features.

## Decisions (grilled 2026-07-24)

1. **Unread jump = FAB only, no setting.** No auto-scroll-on-open option; the
   floating button alone covers it. Shows when the "New" separator exists and
   is above the viewport; tap scrolls to it; sits above the scroll-to-bottom
   FAB.
2. **Reactions: hover 1-click bar + full emoji picker.** Hover directly
   reveals the 6-emoji quick bar (no intermediate click) plus a "+" opening a
   full unicode picker. **Research the picker lib online first** (frimousse is
   the t129 pre-approved candidate — verify it's still the right pick vs
   alternatives before adopting). Teams org custom emojis deferred (reaction
   API for org emoji keys unproven).
3. **Folder DnD: reorder folders + drag conversation into folder;
   server-shared order.** dnd-kit, CDP-sidebar pattern. Folder headers
   drag-reorder in both expanded and collapsed states; dragging a conversation
   row onto a folder moves it there. Order persists server-side (shared across
   devices, like folders themselves).
4. **Multi-attach: one message, probe multi-inline, fallback sequential.**
   Composer holds N pending files. Try all images inline in ONE message
   (multiple AMSImage `<img>` + caption) — live-probe on self-chat during
   build; if Teams rejects, fall back to sequential sends (caption on the
   first). Non-image files send sequentially.
5. **URL copy: small hover copy icon, all three targets.** Inline `<a>` links,
   file-chip shareUrl, recording playback URL. Fine-pointer only; click copies
   + shows a tick.
6. **Prefs sync: re-fetch on the ~12s list-poll cadence.** Change-detect +
   post-local-write grace window — mirror the t103 pins pattern. No SSE.
7. **opt+↑/↓ removed entirely; ⌘[ / ⌘] are THE conv prev/next pair.** Works
   everywhere including a focused composer; composer text-nav keeps native
   opt+arrows. Registry + shortcut overlay updated.
8. **⌘K enrichment: all three groups.** (a) settings toggles (theme, density,
   font size, names mode, notifications); (b) new-feature commands (jump to
   unread, copy link of focused message, reply/quote focused, attach files);
   (c) conversation management (rename, move to folder, label add/remove,
   mute options, collapse/expand all folders).

## Workstreams (each ≈ one session)

### A — Settings & composer polish
- Server-URL Save button same height as its input (share the sizing, don't
  eyeball two paddings).
- Notifications toggle works on the Electron shell too: gate `chat:notify` +
  badge behind the same setting (web keeps the push toggle; one shared row,
  capability-labelled).
- Send button icon → arrow-up (HugeIcons `ArrowUp…`), matching modern chat
  idiom.
- Removing a reply quote (✕ or Esc) keeps/returns focus to the composer input.

### B — Keyboard rework
- `chat-keys.ts`: add ⌘[ / ⌘] (conv prev/next, no composer guard), remove
  opt+↑/↓ bindings; add `/` → focus composer (list + thread; ignored when a
  typing surface already has focus, so typing "/" in the composer still
  inserts).
- Update `command-registry.ts` labels/shortcuts + shortcut overlay. Pure
  `routeKey` tests updated (TDD).

### C — Unread jump FAB
- `thread-view.tsx`: track the separator element's position; FAB (up-arrow +
  "New") when the separator exists and is above the viewport; tap scrolls the
  separator to near-top; hides once the separator has been seen. Stacks above
  the scroll-to-bottom FAB. Pure show/hide predicate unit-tested.

### D — Shared prompt dialog (Electron-safe)
- One `PromptDialog` (shadcn Dialog + input + confirm/cancel, promise-based
  `prompt(opts) → string | null` helper) replacing both `window.prompt` sites
  (rename, move-to-folder) + the label input flow. Autofocus, Enter=confirm,
  Esc=cancel. Verified on the Electron shell.

### E — Lightbox close button
- Add a visible X (top-right). On Electron: offset below the 48px titlebar
  strip **and** mark the button (or the lightbox top strip)
  `-webkit-app-region: no-drag` so the frameless drag region can't eat the
  click. Esc/click-outside unchanged.

### F — Reactions revamp
- Hover on a message reveals the quick-react bar directly (6 defaults, one
  click) — fold the current two-step cluster into one surface.
- "+" opens a full unicode emoji picker. **First: short online research pass**
  (frimousse vs alternatives — bundle size, shadcn fit, search, maintenance);
  adopt the winner as a chat-only dep. Picker reactions ride the existing
  `POST /api/teams/react` key space (`reactionEmoji` already decodes
  unicode-codepoint keys).
- Org custom emojis out of scope (deferred).

### G — URL hover-copy
- Hover overlay copy button on: inline message links (delegated, rendered
  bodies are sanitized HTML — attach via the bubble's mouseover, not per-node
  React), file chips, recording chips. Copies href, tick feedback. Fine-pointer
  only (`pointer: fine`).

### H — Reply-quote bubble styling
- Style the blockquote inside message bubbles like the composer's colorful
  quote chip: author-colored left bar + tinted background + author line.
  Sanitizer allowlist unchanged (style via CSS on `blockquote` within
  `.teams-message-body`, keyed off the existing reply markup).

### I — Folder DnD
- dnd-kit (reuse repo pattern from `src/components/sidebar.tsx`): folder
  headers sortable (expanded + collapsed); conversation rows draggable into a
  folder section (sets `folder` pref — same write as the menu path).
- Folder order: new server-side pref (ordered list in `conversation_prefs`
  storage or a sibling key), shared across devices; alpha order remains the
  fallback for unordered folders.

### J — Multi-file attachments
- Composer: `pendingFiles: File[]` (multi-select input + multi-paste), chip
  row with per-file remove.
- Send: images → probe ONE message with multiple inline AMSImage tags on
  self-chat; on rejection fall back to sequential sends (caption rides the
  first). Non-image files sequential. Progress/failure states honest per file.

### K — Cross-device prefs sync
- Re-fetch `conversation_prefs` on the ~12s list-poll tick (paused hidden,
  refresh on focus); apply only on actual change; grace window after a local
  write (t103 pins pattern). Folder order (I) rides the same store, so it
  syncs for free.

### L — ⌘K enrichment
- Add all three grilled groups to `command-registry.ts`, context-gated as the
  registry already does. Depends on B, C, F, G, I (commands reference their
  features). Shortcut overlay regenerates from the registry.

### M — Bug sweep (last)
- Full pass over the epic on web PWA + Electron shell against the probe host
  (`100.85.206.8:9222`): keyboard matrix, DnD edge cases (collapsed drag,
  empty folder), multi-attach failure paths, lightbox on both builds, prefs
  two-device convergence. Fix regressions; vitest + typecheck + lint green.

## Dependency / parallelism table

| Workstream | Depends on | Parallel with |
|---|---|---|
| A settings/composer polish | — | everything |
| B keyboard | — | A, C–K |
| C unread FAB | — | A, B, D–K |
| D prompt dialog | — | A–C, E–K |
| E lightbox X | — | A–D, F–K |
| F reactions | — | A–E, G–K |
| G URL copy | — | A–F, H–K |
| H quote styling | — | A–G, I–K |
| I folder DnD | D (shared write paths helpful, not hard) | A–H, J, K |
| J multi-attach | — | A–I, K |
| K prefs sync | — | A–J (I's order key lands before or after; both fine) |
| L ⌘K enrichment | B, C, F, G, I | — |
| M bug sweep | all | — |

## Acceptance criteria

- [ ] Server-URL Save button height matches its input pixel-for-pixel.
- [ ] Notifications toggle gates Electron shell notifications (`chat:notify` +
      dock badge) as well as web push; one settings row on both builds.
- [ ] Send button shows an arrow-up icon.
- [ ] Removing a reply quote keeps the composer focused.
- [ ] ⌘[ / ⌘] switch prev/next conversation everywhere, including while the
      composer is focused; opt+↑/↓ no longer switch conversations; overlay +
      ⌘K reflect the change.
- [ ] `/` focuses the composer when it isn't already a typing surface.
- [ ] A thread with an off-screen "New" separator shows a jump FAB; tapping it
      scrolls to the separator; the FAB hides once seen. No FAB when no
      separator.
- [ ] Rename, move-to-folder, and label inputs use the shadcn prompt dialog
      and work on the Electron app (no `window.prompt` remains in `chat/src`).
- [ ] Lightbox shows a clickable X on both builds; on Electron it is not
      swallowed by the titlebar drag region.
- [ ] Hovering a message reveals the reaction bar directly; one click reacts;
      "+" opens a full emoji picker whose reactions round-trip (optimistic +
      poll-reconciled, self-chat verified).
- [ ] Hovering an inline link, file chip, or recording chip (fine pointer)
      shows a copy button; click copies the URL with feedback.
- [ ] Reply quotes inside bubbles render colorful (author bar + tint), visually
      consistent with the composer chip.
- [ ] Folders drag-reorder in expanded and collapsed states; a conversation
      dragged onto a folder moves into it; folder order persists server-side
      and appears on a second device.
- [ ] Composer accepts multiple files; images send inline in one message when
      Teams allows (probed), otherwise sequential; non-image files sequential;
      per-file failure is honest.
- [ ] A folder/label/rename made on device A appears on device B within ~15s
      without reload; a local edit is never reverted by a stale poll.
- [ ] ⌘K includes settings toggles, new-feature commands, and conversation
      management verbs, each context-gated.
- [ ] vitest + typecheck + `pnpm check:changed` green; `/` browser build
      byte-unchanged where untouched.

## Risks

- **Multi-inline AMS images unproven** — mitigated by the grilled fallback
  (sequential sends); probe is scoped to self-chat.
- **DnD + collapse interplay** — collapsed folder headers are small targets;
  reuse dnd-kit sensors/thresholds from the CDP sidebar rather than tuning
  fresh. Conversation-drag must not fight row click/context-menu.
- **Hover-copy inside sanitized HTML** — must not re-introduce per-node React
  into `dangerouslySetInnerHTML` bodies; event delegation only, and the
  affordance must not shift layout (absolute overlay).
- **Emoji picker dep** — chat-only dependency; keep out of the `/` renderer
  and Electron browser build (mirror the dompurify precedent).
- **Prefs-sync poll racing local writes** — grace-window pattern is proven
  (t103) but folder-order writes (I) add a new key; keep one write path.

## Out of scope

- Teams org custom emojis as reactions (API unproven — deferred).
- Auto-scroll-to-unread setting (grilled: FAB only).
- SSE push for prefs sync (poll chosen).
- Inline recording playback (rejected t162; copy-URL only).
- Rich adaptive-card rendering, trouter realtime (standing deferrals).
