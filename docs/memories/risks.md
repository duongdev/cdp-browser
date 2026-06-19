# Risks

Known risks, limitations, and areas to watch. Update as the project evolves — append new entries, update status on existing ones.

**Format:** one entry per risk. Include ID, status, description, mitigation or acceptance rationale.

**Status legend:**
- 🔴 **Open** — active risk, mitigation not yet in place
- 🟡 **Mitigated** — action taken, monitoring
- 🟢 **Closed** — resolved, no longer a concern
- ✅ **Accepted** — conscious decision to live with it
- 💥 **Realised** — happened; post-mortem or lesson recorded

---

## R-001 — CDP "Connecting…" hangs on unreachable host ✅ Accepted

**Status:** ✅ Accepted — partially mitigated

**Risk:** If the Remote Browser is not running or the configured host/port is wrong, the app shows a persistent "Connecting…" state with no timeout, no error message, and no guidance on how to recover. The user is stuck until they open Settings and change the address.

**Mitigation in place:** Settings drawer is accessible via `⌘,` even during the connecting state. The status bar shows the error text from the failed HTTP `/json` call.

**Remaining gap:** no automatic timeout that surfaces a human-readable error ("Could not reach Remote Browser at host:port — check that the browser is running with `--remote-debugging-port=9222`"). This would turn a stuck state into a recoverable one.

**See also:** `CLAUDE.md` Troubleshooting → "Connecting... stuck".

---

## R-002 — Screencast only works for the active tab ✅ Accepted

**Status:** ✅ Accepted — inherent CDP constraint

**Risk:** `Page.startScreencast` only streams frames for the tab that is currently active on the Remote Browser. If the user switches tabs in the Remote Browser directly (not through CDP Browser), the screencast goes stale until CDP Browser switches to follow it.

**Root cause:** CDP screencast is per-page-target and requires the target to be the frontmost/active tab. This is a Remote Browser constraint, not a bug in CDP Browser.

**Mitigation:** none available at the CDP level. The user must always drive tab switching from CDP Browser, not from the Remote Browser window.

**Related:** the Notification Side-Channel is explicitly designed to work on *background* tabs (read-only, no screencast) — it avoids this limitation by not using screencast.

---

## R-003 — No IME / CJK text input support 🔴 Open

**Status:** 🔴 Open

**Risk:** Text input is forwarded via `Input.dispatchKeyEvent`. IME (Input Method Editor) composition — required for CJK languages (Chinese, Japanese, Korean) and Vietnamese Telex/VNI input — is not supported. Characters typed via an input method appear incorrectly or not at all.

**Root cause:** `Input.dispatchKeyEvent` models individual key events, not IME composition events. Correct IME support would require intercepting `compositionstart`/`compositionupdate`/`compositionend` events and mapping them to CDP's `Input.imeSetComposition` / `Input.insertText` methods.

**Impact:** affects any user who types in a CJK language or uses a Vietnamese keyboard layout with composition.

**Mitigation path:** implement IME support as a new `InputIntent` variant (`{ kind: "composition", ... }`) in `remote-page.ts`. Main process translates to `Input.imeSetComposition` / `Input.insertText`. Non-trivial; estimate 1–2 days.

**Workaround:** users can paste pre-composed text via `Cmd+V` (clipboard paste is forwarded as `Input.insertText`).

---

## R-004 — Screencast frames are CSS-resolution (soft on HiDPI) ✅ Accepted

**Status:** ✅ Accepted — not currently worth fixing

**Risk:** `Page.startScreencast` produces CSS-resolution JPEG frames regardless of `deviceScaleFactor`. On a Retina (2× DPI) display the canvas upscales these frames 2×, resulting in soft/blurry rendering.

**Root cause:** `Page.startScreencast` ignores `deviceScaleFactor` in its parameters. Sharp device-resolution frames are only available via `Page.captureScreenshot`, which is too heavy to stream and introduces color-shift vs. screencast. Documented in `docs/adr/0002-adaptive-viewport.md`.

**Mitigation:** none viable without unacceptable performance cost or color-shift artifacts.

**Accepted because:** the soft rendering is an inherent limitation of the CDP screencast API. Users who find it unacceptable can use Adaptive Viewport mode to at least eliminate letterbox bars.

---

## R-005 — Tab favicons may not load (cross-origin) 🟡 Mitigated

**Status:** 🟡 Mitigated — graceful fallback in place

**Risk:** Favicons are fetched by the renderer from the URL reported by the Remote Browser. If the Remote Browser enforces CORS or the favicon URL is relative (e.g. `/favicon.ico`), the fetch may fail and the tab shows a blank or placeholder icon.

**Mitigation:** the `sidebar.tsx` tab list falls back to a generic globe icon when the favicon fails to load. The URL is shown as the tab label even without a favicon.

---

## R-006 — Reader history + reply writes add new load on extracted Slack creds 🔴

**Status:** 🔴 Open

**Risk:** ADR-0012 adds two new traffic patterns on the sweep's extracted creds: on-demand `conversations.history` fetches when the Conversation Reader opens (t077) and `chat.postMessage` writes (t078) — the first **writes** through `xoxc`/`d`-cookie creds. Risks: eating into the sweep's 429 budget (a burst of reader opens could degrade notification capture), stale-cred failures becoming user-facing on a phone where the user can't fix them directly, and enterprise visibility of write traffic from a non-browser client pattern.

**Mitigation:**
- Reader/reply calls go through the same `slack-api.js` client (429-aware, typed 401) — no parallel client.
- Send failures are synchronous + honest (draft retained, retry); no outbox that could post stale messages (ADR-0012).
- Stale creds self-heal via the parked-tab keeper re-extract; error copy says "retry in a minute".

**Trigger to escalate:** sweep capture gaps correlated with reader usage (429s in server logs), or a cred-stale loop that doesn't self-heal within one parked-tab cycle.

---

## R-007 — Dokploy API returns all stored secrets in cleartext 🔴 Open

**Status:** 🔴 Open

**Risk:** The Dokploy control plane API returns every stored secret in cleartext to any holder
of the `x-api-key` token (`pass://Personal/dokploy/api_key`). Exposed material includes the
Dokploy GitHub App private key, the dell01 SSH private key, and other projects' env secrets
(live DB credentials, third-party tokens). The API key is effectively a homelab master
credential and must be treated as such.

**Mitigation in place:** key is stored in `pass`, not in any file or shell history.

**Remaining gap:** the key is not rotated, not scoped to read-only, and not restricted by
IP/ACL. Rotation + key scoping are operator-side tasks (Dokploy UI → API keys).

**Trigger to escalate:** any indication the key has been exposed (CI logs, leaked env, etc.)
— treat as a full homelab credential compromise.

**Discovered:** 2026-06-19 (t094 recon).

---

_Add new entries at the bottom. Update status in-place. Never delete entries — mark them 🟢 Closed instead._
