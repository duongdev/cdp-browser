# Chat QA checklist

Manual-QA runbook for the `/chat` surface. One source of truth — covers the mock stack, UI areas,
and what cannot be verified locally. Cases are **extended, never rewritten** — every fixed bug earns
a row. How a run is dispatched (subagents, real input events, long-and-short content, isolated
stacks) lives in [docs/conventions/e2e-verification.md](../conventions/e2e-verification.md);
`/regression` runs it.

**Last run:** 2026-07-28 · commit `23ffa6f`
QE1 (8 defects found — DEF-1 blank-body data loss, DEF-2 delete timestamp, DEF-3 last-sync never
advancing, DEF-4 deferred conversations never retried, DEF-5 truncated off-by-one, DEF-6 dead error
path, DEF-7 Node version, DEF-8 mock 500-not-404; all since fixed). QE2: all areas PASS. QE3:
32 PASS / 1 inconclusive (TC-25 profile→lightbox, since verified by hand) / network-dependent cases
skipped. QE4 (PSN-115 global search): Area 10 SB-01..SB-30 — 28 PASS, 2 BLOCKED (SB-15 shared-
browser keystroke theft from concurrent subagents, not an app defect; SB-21 the mock provider has
no rate-limit-trigger hook — the degraded path is unit-tested, just not drivable live). Smoke
D/A/C/R: all PASS after a contention-caused BLOCKED batch was re-run on a dedicated isolated stack
(`pnpm test` 2181/2181 green on Node 24). Also live-probed the deployed preview
(preview-cdp-browser-app-1yrpdy-s8slux.dp.dustin.one, serving this same commit) against real Teams
data — search, sort/scope-always-visible, URL restore, result→thread jump, and dark theme all PASS,
zero search-related console errors.

---

## Boot the mock stack

Requires **Node 24** (`nvm use 24` — `better-sqlite3` is compiled for Node 24 ABI; Node 22/20 fails
with `ERR_DLOPEN_FAILED`).

```bash
pnpm chat:mock                         # builds both bundles, boots BFF :7910 + web :7900
open http://localhost:7900/chat        # browser surface
pnpm chat:mock:electron                # CDP Chats Electron shell (optional)
pnpm chat:mock:say -d '{"text":"hi"}' # inject an inbound message into the default conv
# or target a specific conversation:
pnpm chat:mock:say -d '{"convId":"19:project@thread.v2","text":"hi"}'
```

State writes to `.mock-data/` (gitignored). The real `chat.db`, `web-settings.json`, and the
installed app config are never touched. `Ctrl-C` kills both processes together.

Concurrent runs must not share a stack — set `MOCK_DIR`, `WEB_PORT` and `BFF_PORT` per run (every
`chat:mock*` script honours them):

```bash
MOCK_DIR=.mock-data-b WEB_PORT=7920 BFF_PORT=7930 pnpm chat:mock
MOCK_DIR=.mock-data-b WEB_PORT=7920 pnpm chat:mock:say -d '{"text":"hi"}'
```

## Mock fixtures

`apps/chat-server/src/providers/mock-provider.ts` seeds the following out of the box:

| Conversation | Notable content |
|---|---|
| Other Person | basic 1:1 thread |
| Project X | @mentions, reactions, edited message, tombstone |
| Release train | 30-message thread (pages); Jira / Azure DevOps PR / long-URL links |
| Noisy Bot | muted; bell indicator in sidebar |
| Renamed by me | sidebar shows "Renamed by me"; thread header shows the original name |
| Design review | file attachment, system line, avatar photo |
| You (You) | `48:notes` self-chat; own-message edit/delete affordances |

Message ids are fixed; timestamps are relative to process start, so relative-time labels look real
without drifting within a run. `MOCK_PREFS` seeds folder, mute, and rename state. Page size is
controlled by `CHAT_MOCK_PAGE` (default 20 in the mock stack, 2 in unit tests).

---

## Test cases

Each row: **id · what to do · what must happen.** Run from top to bottom; later areas assume earlier
ones pass.

### 1. Delivery

| ID | Steps | Must happen |
|----|-------|-------------|
| D-01 | Load `/chat`, open Project X, hide tab (`document.hidden` override or browser-minimize), `pnpm chat:mock:say` into that conv, wait 7s | Message appears in thread AND sidebar row preview — no reload |
| D-02 | `pnpm chat:mock:say -d '{"convId":"19:release@thread.v2","text":"x"}'`, wait 7s, open that conv | Row preview updated; thread already has the message (no fetch flash) |
| D-03 | 5 concurrent `mock/say` POSTs into the open conv, wait 9s | All 5 rendered, no duplicates |
| D-04 | Kill the BFF (`kill -9`), wait 6s | "Reconnecting…" banner appears; last-good sidebar stays (no wipe) |
| D-05 | Restart the BFF after D-04, wait 9s, send a message | Banner clears; message delivered |
| D-06 | `kill -STOP <bff-pid>` (no FIN), wait 45s | "Reconnecting…" banner appears ≤45s (watchdog timeout) |
| D-07 | `kill -CONT` after D-06, send a message | Banner clears; delivery resumes |
| D-08 | With 8+ conversations, inject messages across all of them in one burst; wait 15s | All conversations receive their messages (none silently deferred forever) |

### 2. Edit / delete history

| ID | Steps | Must happen |
|----|-------|-------------|
| H-01 | Edit a Project X message twice (via `POST /api/chat/edit`), open the `(edited)` popover | Popover shows 3 versions newest→oldest; `current` body is the latest edit |
| H-02 | Re-sweep (wait 12s) without touching the message | Version count unchanged |
| H-03 | Delete the same message, sweep, click `view original` on the tombstone | Popover shows the original body; `current.deleted` = true |
| H-04 | Edit a message to the same text again (no change) | No new version added |
| H-05 | Edit a message to `""` (empty string) | Old body preserved (either reject or snapshot first — never silent overwrite) |
| H-06 | Make exactly 20 edits on one message, call `GET /api/chat/message-history` | `truncated: false`; oldest kept version is the original body |
| H-07 | Make 21 edits on one message | `truncated: true`; 20 versions returned; popover says some were dropped |
| H-08 | Edit, sweep, then delete, sweep; open the tombstone popover | Delete version carries the deletion time, not the previous edit's timestamp |

### 3. Settings — About + Sync + Backfill

| ID | Steps | Must happen |
|----|-------|-------------|
| S-01 | `⌘,` → About | App version = `package.json` version; SHA = real HEAD commit; built-at is a valid date |
| S-02 | Same | Server version/SHA row present and matches the web server's `/api/version` |
| S-03 | Same | Chat BFF version/SHA row present |
| S-04 | Same | Live `cdp_device_id` shown with a copy button |
| S-05 | Kill the BFF, close and reopen Settings | Chat BFF row shows an error/unavailable state (not just "no data") |
| S-06 | Restart the BFF, reopen Settings | BFF row recovers to version/SHA |
| S-07 | Open Settings, wait 25s without touching the UI | "Last sync" value advances (does not keep aging) |
| S-08 | Open Settings after a few sweeps | Last ~20 sync events visible; per-conversation focus failures show the convId |
| S-09 | Force a focus failure (open a non-existent conv) | Failure logged in event log; service health row does not flip red |
| S-10 | Backfill trigger (if present) | Backfill progress indicator appears; completes without error |

### 4. Hover overlays and tooltips

| ID | Steps | Must happen |
|----|-------|-------------|
| V-01 | Hover 4 messages rapidly (< 180ms each) | Reaction toolbar never opens (open delay = 180ms) |
| V-02 | Hover a message for 300ms | Exactly 1 reaction toolbar visible; moving to the next message swaps (never 2 at once) |
| V-03 | Hover a message, then `window.blur` | Toolbar closes within 200ms |
| V-04 | Hover a message, switch to another conversation | Toolbar closed |
| V-05 | Open the emoji catalog picker ("+"), move cursor away | Toolbar stays (locked by picker) |
| V-06 | Escape to close the picker, move cursor away | Toolbar closes |
| V-07 | Hover "Message actions" ⋯ button → tooltip appears; click to open menu; Escape | No tooltip text visible after Escape |
| V-08 | Hover "+" on the reaction bar → tooltip; click to open picker; Escape | No tooltip text visible after Escape |
| V-09 | Close the profile dialog while the avatar lightbox is open | Lightbox does not re-open on the next profile you view |
| V-10 | Hover a message to open its reaction bar, then move the cursor in a straight line from the bubble to the bar (crossing the gap) | Bar stays open through the transit (close is cancelled on bar `mouseenter`); no flicker |
| V-11 | Hover message A (bar opens), then while A's bar is still open, brush message B's box (a quick `mouseenter` on B) | A's bar is NOT instantly evicted; B does not steal ownership until its own `openDelay` fires. A closes on its own 300ms grace after the cursor leaves A's region |
| V-12 | Two stacked bubbles: hover the lower one, then move the mouse up across the upper bubble's box toward the lower one's bar | Lower bar stays open; upper bar does NOT open (waits `openDelay`, doesn't yank ownership) |
| V-13 | Inspect the bridge element between a bubble and its open reaction bar | A transparent `<span>` (`aria-hidden`) spans the bubble→bar gap; `getBoundingClientRect` is bounded to the bubble box (no horizontal overflow past the viewport) |

### 5. Composer

| ID | Steps | Must happen |
|----|-------|-------------|
| C-01 | Set viewport to 320px wide, inspect the composer footer (send button row) | Footer is one row, no wrapping, send button reachable |
| C-02 | Repeat C-01 at 480px, 640px, 768px, 1280px | Single row at all widths |
| C-03 | Type `**bold** ` in the composer | `<strong>` applied; preview shows bold text |
| C-04 | Type `_italic_ ` | `<em>` applied |
| C-05 | Type `` `code` `` | Inline code applied |
| C-06 | Type `@` in Project X | Roster dropdown appears with member names |
| C-07 | Pick a mention from the roster, send | Message renders with `@Name` mention pill |
| C-08 | Open emoji picker, pick 😀, send | Message contains the emoji |
| C-09 | Click GIF button | Picker opens (grid load requires `GIPHY_API_KEY` — button presence is sufficient here) |
| C-10 | Type a long message, Enter to send | Message appears in thread optimistically; no crash |
| C-11 | Shift+Enter in the composer (outside a list/code-block) | New paragraph created (`splitBlock`); message not sent; typing `- item` on the new line wraps ONLY that paragraph into a bullet list |
| C-12 | Inside a bullet list, Shift+Enter | HardBreak line-break within the same list item (no new paragraph, no new list item) |
| C-13 | Click the Aa / Formatting toggle, then the Attach button, without moving the caret | Editor keeps focus both times (`.ProseMirror` is still `document.activeElement`) |
| C-14 | With an empty selection, click each BIUS chip (B / I / U / S) | Chip's `data-state` flips to `on` immediately (no caret move needed); `editor.isActive('bold'\|'italic'\|'underline'\|'strike')` returns true right after the click |
| C-15 | Click each block-format button (inline code, code-block, quote, bullet list, numbered list), then move the caret into/out of that block | Button carries `aria-pressed="true"` + accent bg while the caret is inside the block; flips to `aria-pressed="false"` when the caret leaves |

### 6. Assistant panel

| ID | Steps | Must happen |
|----|-------|-------------|
| A-01 | Click the AI button (`⌘⌥B`) | Panel opens |
| A-02 | Create a new session, type `keepalive-test` in the AI input | Draft saved in the editor |
| A-03 | Switch to a different conversation, then switch back | Typed draft still present (session pane was kept alive, not unmounted) |
| A-04 | Open 5 sessions (exceeds MRU cap of 4) | Oldest session removed from keep-alive; 4 remain |
| A-05 | Ask a question about a conversation | Response streams in; citations render (e.g. "sender: excerpt") |
| A-06 | Hover a citation chip | Source info visible (sender, timestamp, excerpt) |
| A-07 | Use a quick action (Summarize / Catch up / Draft reply / Action items) | Pre-seeded prompt auto-sends |
| A-08 | Click "Insert into composer" on an answer | Text inserted into the thread composer; NOT auto-sent |
| A-09 | Drag the AI panel column resize handle | Panel width changes; persists on reload |

### 7. Links

| ID | Steps | Must happen |
|----|-------|-------------|
| L-01 | Hover any link in a message | Full URL appears in `title` (browser tooltip) |
| L-02 | Hover `https://example.atlassian.net/browse/PSN-105` | Link text shows `PSN-105`; title = full URL |
| L-03 | Hover a long URL | Text is elided with `…`; title = full unmodified URL |
| L-04 | Hover `https://dev.azure.com/org/Proj/_git/repo/pullrequest/42` | Text shows `repo#42`; title = full URL |
| L-05 | Hover a short descriptive link (e.g. `repo#42`) | `title` attribute present even though no elision occurred |
| L-06 | Hover a link until the copy button appears | Copy button appears at the end of the link's last line |
| L-07 | Click the copy button | Full URL in clipboard |
| L-08 | Switch conversations while hovering a link | Copy overlay dismissed |

### 8. Conversation list

| ID | Steps | Must happen |
|----|-------|-------------|
| CL-01 | Load `/chat` | All 7 mock conversations visible |
| CL-02 | Check Noisy Bot row | Mute bell icon visible; does not overlap the timestamp |
| CL-03 | Check Renamed by me in the sidebar | Shows "Renamed by me"; "Original Topic" absent |
| CL-04 | Click Renamed by me | Thread header shows "Original Topic" (original name) |
| CL-05 | Check unread conversations | Coral dot on unread rows; title is semibold |
| CL-06 | Check "Work" folder | "WORK" section header visible (CSS-uppercased "Work" in DOM) |
| CL-07 | Press `j` / `k` | Focus moves to next / previous conversation |
| CL-08 | Press `⌘1` | First conversation opens |
| CL-09 | Press `⌥↑` / `⌥↓` | Previous / next conversation opens |
| CL-10 | Press `u` on an unread conversation | Conversation marked read (dot clears) |
| CL-11 | Press `u` again | Conversation marked unread (dot returns) |
| CL-12 | Press `⌘K` | Command palette opens |
| CL-13 | Press Escape | Palette closes; no DOM remnants (`[role="dialog"]` = 0 visible) |
| CL-14 | Switch between 3 conversations rapidly | No crash; last selected conversation renders |
| CL-15 | In a group conv (≥3 members, kind==="group"), have another member send `pnpm chat:mock:say`; read the sidebar row preview + the `chat:notify` / web `Notification` body | Both the row preview and the notification body start with `"FirstName: "` (first name only, regardless of name-display pref) |
| CL-16 | Send a message yourself in the same group conv (last message is from-me) | Row preview has NO sender prefix (no "You:") |
| CL-17 | In a 1:1 DM, have the other person send | Row preview has NO sender prefix (1:1 never prefixed) |
| CL-18 | In a group conv whose last-message row isn't swept yet (unknown sender) | Row preview degrades to no prefix (no `"undefined:"`) |
| CL-19 | `GET /api/chat/conversations` on a group conv | Response row carries `lastMessageSender` (the sender's name from the `messages` JOIN) |

### 9. Core regression

| ID | Steps | Must happen |
|----|-------|-------------|
| R-01 | Open Release train (30-msg thread), scroll to top | Older messages load (or `hasOlder: false` when the mock cursor is exhausted — no crash) |
| R-02 | Send a message in You (You) | Message appears optimistically; no duplicate after poll |
| R-03 | Open Other Person thread, hover a message | Reply button visible (`aria-label="Reply"`) |
| R-04 | Hover own message in You (You), click "Message actions" | Edit and Delete options visible |
| R-05 | `⌘,` → About | Device ID `device_…` visible; copy button present |
| R-06 | Emulate dark color scheme | Background is dark; text readable; no white-on-white |
| R-07 | Emulate light color scheme | Normal light UI |
| R-08 | Set viewport to 390×844 | All conversations visible; composer reachable |
| R-09 | Navigate to `/chat/c/{convId}?jump={msgId}` | Animated outline ring (`msg-jump-flash`) on the target message |
| R-10 | `pnpm test` | All tests pass (currently 1992/1992) |
| R-11 | `pnpm typecheck` | Clean |
| R-12 | `BIOME_SINCE=origin/main pnpm check:changed` | Clean |

---

### 10. Global message search (PSN-115)

Proactive backfilling + full-screen search. Local FTS is the fast path; substrate (Teams server-side search) fills gaps; hits hydrate into `chat.db` and the WS `messages-upsert` delta flips `hydrated:false` rows live. Deep plan: [`PSN-115-search-e2e-plan.md`](PSN-115-search-e2e-plan.md).

| ID | Steps | Must happen |
|----|-------|-------------|
| SB-01 | From `/chat/`, hit `⌘K` → "Search messages" | Route changes to `/chat/search`; AI + conversation-list columns hidden; left rail = search input, middle = placeholder |
| SB-02 | Click the search icon at the top of the AI-assistant rail | Same `/chat/search` surface opens |
| SB-03 | Type a term that exists in seeded messages (e.g. `deploy`) | Debounced (~250ms); result rows populate: sender · convTitle, snippet, relative time |
| SB-04 | Row 1 | The matched term is wrapped in a yellow `<mark>` highlight (readable in light + dark) |
| SB-05 | Click a result | Middle ThreadView opens that conversation scrolled to the message; `msg-jump-flash` ring appears |
| SB-06 | A substrate hit whose message is NOT in `chat.db` (mock fixture: gap hit) | Row shows a muted "fetching context…" pill; after the WS `messages-upsert` delta lands, the pill disappears (hydrated flip) |
| SB-07 | Click that un-hydrated substrate hit | ThreadView fetches the window and renders the message (not a permanent `missing`) |
| SB-08 | Clear the query | Empty state: "No messages" + hint + icon; FilterBar hidden |
| SB-09 | Type a nonsense term | Empty state (not an error) |
| SB-10 | Kill the BFF mid-query, retry | Error state with a Retry button; no crash |
| SB-11 | Type `from:alice deploy` | FilterBar shows a `from: alice` chip (removable ×) + the free-text runs the query; `parsed` echo drives the chips |
| SB-12 | Click the × on the `from:` chip | Operator stripped from the query; search re-runs with the free text only |
| SB-13 | Toggle sort Relevance ⇄ Recent | First-row identity changes; choice persists across reloads (`chat:search-sort`) |
| SB-14 | Toggle scope DMs / Groups / All | Result set filters by conversation kind; All = unfiltered |
| SB-15 | Keyboard: focus the listbox, `j` / `k` | Selection moves; `Enter` opens the focused row; `Esc` returns to `/chat/` |
| SB-16 | Run two searches; reload | Recent searches (≤5) persist; click a recent to re-run |
| SB-17 | Long/short: type a 1-char query, then a 300-char query | Result rows + FilterBar don't overflow; snippet wraps, no horizontal scroll |
| SB-18 | Long/short: a hit whose convTitle is 200 chars mixed-script (VN/CJK) | Row truncates cleanly; no layout shift |
| SB-19 | Dark scheme, populated + empty | No contrast/clipping; highlight + pill readable |
| SB-20 | `POST /api/chat/search {service:"teams",query:"deploy"}` direct | 200; `rows` merge local + substrate; `parsed` echo present; `degraded` absent |
| SB-21 | Mock provider returns 0 hits + `degraded:"rate_limited"` | Response carries `degraded`; UI shows the yellow "local results only" banner |
| SB-22 | `pnpm test` (chat-server + chat FE) | Search/hydrate/parser unit + integration suites green |
| SB-23 | `pnpm typecheck` + `BIOME_SINCE=origin/main pnpm check:changed` | Clean |
| SB-24 | Search a term whose match sits at index 0 of a snippet (e.g. every seed message starts with it) | `<mark>` highlights the correct word, not the text after it (regression: parity bug had this backwards) |
| SB-25 | Search a plain string, zero KQL operators | Sort (Relevance/Recent) + scope (All/DMs/Groups) toggles still visible (regression: FilterBar used to hide entirely with no chips) |
| SB-26 | Load `/chat/search?q=deploy&sort=recent&scope=group`, no typing | Query, sort, and scope all restore from the URL |
| SB-27 | Drag the seam between the search left rail and the middle pane; double-click it | Resizes live; double-click resets to default; same width reflected on `/chat/`'s conversation list (shared `listWidth`) |
| SB-28 | With 2+ recent searches, click one row's × , then "Clear all" | Only that row disappears first; "Clear all" empties the rest |
| SB-29 | Open a search result whose conversation isn't in the local list yet (substrate-only hit) | Middle pane's stub conversation reflects the hit's real `convKind` (no hardcoded "Group chat" for what's actually a DM) |
| SB-30 | From `/chat/`, click the search icon in the main app header (top bar, not inside the AI panel) | Opens `/chat/search` — the entry point that exists even when the AI panel (closed by default) has never been opened |

---

## Cannot be verified locally

| Area | Why |
|------|-----|
| Real Teams tenant paths | Everything runs through `CHAT_PROVIDER=mock`. No cred minting, no CDP keeper tab, no AMS media, no real send/edit/mark-read round-trip against the service. DEF-2 (delete timestamp) depends on whether the real provider clears `edittime` on a tombstone — reproduced against the mock, plausible but unconfirmed against Teams. |
| Web Push | The mock BFF boots without VAPID keys. Push needs an installed PWA over HTTPS. |
| Two-window minimised-Electron | Electron shell notifies while backgrounded (confirmed via mock, I-05 in QE1), but the reported two-client symptom on the real transport has not been driven end-to-end. |
| GIF / sticker grid content | Requires Giphy CDN and `GIPHY_API_KEY`. Button presence verifiable locally; grid content is not. |
| Health flapping (list lane fails / focus lane succeeds) | The mock uses one object for both lanes — a split failure cannot be induced. Suspected edge case; not marked PASS. |
| OS toast pixel rendering | `[chat] notify <convId>: …` in the shell log proves the IPC hop; whether the macOS notification actually draws requires a human eye. |

---

_Last revisited: 2026-07-28_
