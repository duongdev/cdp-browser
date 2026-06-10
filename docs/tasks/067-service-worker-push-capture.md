# 067 — capture service-worker push notifications (Slack)

- **Status:** in-progress
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** 066 (keep-alive keeps the SW registration warm)
- **Blocks:** none

## Goal

The page hook (`window.Notification`, `slack-notify.js`) only sees notifications Slack fires
from the **page** realm. Slack also delivers notifications from its **service worker's**
`push` handler via `registration.showNotification(...)`, a separate realm the page script
can't reach — these were silently missed. After this task the side-channel also attaches to
the matching `service_worker` target and patches `showNotification` there, shipping the same
`__cdpNotify` toasts so SW-delivered notifications are captured too.

## Why now

Builds directly on t066: once background tabs stay alive, the remaining gap is the
SW-`push`-only deliveries. This closes the last "notification didn't show up" hole.

## Acceptance criteria

- [ ] `reconcile` attaches a side-channel to a `service_worker` target whose adapter declares `swScript`.
- [ ] The SW channel injects via `Runtime.evaluate` (no `Page` domain on a worker).
- [ ] SW channels never receive the t066 page keep-alive (`setWebLifecycleState`).
- [ ] A SW-`__cdpNotify` toast is ingested + grouped + fired through the same store path.
- [ ] Per-workspace `groupKey` comes from the payload (the SW URL has no team id).
- [ ] SW channel is dropped when the worker disappears from `/json`.

## Test plan

### Layer 1 — Pure logic (TDD)

- [x] sidechain SW attach — attaches to a `service_worker` w/ swScript, evaluates the SW script, no Page domain, no keep-alive, drops on vanish, page+SW coexist.

### Layer 2 — Manual smoke (CDP/IPC) — **REQUIRED, blind-spots below**

- [ ] With Slack push enabled on the remote browser, trigger a SW push (close all Slack tabs' focus / use a push that routes through the SW) → notification is captured.
- [ ] Inspect the one-time `[cdp-sw-notify] sample options:` log in the worker console; **tighten `TEAM_RE`/`probe` keys to the real payload** if workspace grouping is wrong.
- [ ] Confirm per-workspace `groupKey` resolves (else all workspaces merge under the SW origin).

## Design notes

- **Contracts changed:** adapter gains optional `swScript`; `reconcile` matches `service_worker` targets; new `attachServiceWorker` path + `inject/slack-sw-notify.js`.
- **Known limitation (documented, not fixed here):** a worker that spins up fresh on a push and fires `showNotification` *before* the next 5s reconcile attaches is missed — there's no SW-start barrier. A hardened version would use a browser-level CDP session with `Target.setAutoAttach({ waitForDebuggerOnStart: true })` to attach + inject before the worker runs. Deferred; the t066 page keep-alive keeps the registration warm enough to be listed across reconciles in the common case.
- **Payload shape is a guess:** Slack's SW push `data` isn't publicly documented; `slack-sw-notify.js` probes defensively and logs a sample once for HITL tightening.
- **New ADR needed?** no — extends ADR-0003 (notifications side-channel).
