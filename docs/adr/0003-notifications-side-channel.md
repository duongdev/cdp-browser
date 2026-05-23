# Notifications via read-only side-channel sessions

To surface Teams messages while another tab is in view, the app captures each notification-capable site's **own in-app toast** and re-presents it as a native notification + a toolbar bell. Capture must work when the site is a **background** tab — exactly when the active-tab screencast socket (`activeWs`) is connected elsewhere.

## Multiple CDP clients per target

ADR 0001 (single Remote Page) and ADR 0002's "rejected: one WebSocket per Tab" both rest on the old "one debugger per tab" limit. That limit no longer holds on **Edge 148** (Chromium 148): multiple WebSocket clients can attach to the same `/devtools/page/<id>` target, each a fully functional session (verified — one socket held `Page`+`Runtime` while a second independently ran `Runtime.addBinding` and received `Runtime.bindingCalled`).

So the single-Remote-Page rule is narrowed: it governs the **rendering/screencast** session only. Auxiliary **read-only side-channels** — no screencast, no input — are permitted as separate sockets. They never touch `activeWs` and need no teardown dance on tab switch.

## Design

- **Adapters** identify notification-capable sites by URL host (Teams now; the structure generalises). Each carries an injected capture script.
- **Reconciler** (main process) polls `/json` every 5s (no browser-level connection → no `Target.targetCreated` events). For each matching target without a side-channel it opens one: `Runtime.enable`, `Runtime.addBinding('__cdpNotify')`, `Page.addScriptToEvaluateOnNewDocument` (future loads) **and** an immediate `Runtime.evaluate` (already-loaded document). Vanished targets are dropped. The `isAttached` map is keyed by **target id** — attach to *all* matching tabs (never miss a leader-only toast); dedup happens later.
- **Capture** (`inject/teams-notify.js`) — a `MutationObserver` watches `[data-testid="notification-wrapper"]`. The toast text is the source/title/body; the durable navigation target lives in the React fiber (`memoizedProps.targetEntity = {action, type, id, dataOptions.userContextId}`), not the DOM. The notification id is the `aria-labelledby` suffix. Each capture is shipped through the `__cdpNotify` binding.
- **Store** — pure logic (dedup by notification id, newest-first, cap 50, OS-toast gating) lives in `notifications.js`, tested by `notifications.test.ts`; main owns effects (WS, Electron `Notification`, persistence to `notifications.json`, IPC). Dedup by **notification id** is cross-tab safe: the same id from two tabs is the same toast mirrored; different accounts produce different ids.
- **OS toast** fires when enabled, *unless* the site's own in-app toast is already visible — i.e. its tab is active **and** the app window is focused. Switch tabs or alt-tab to another app and the OS toast fires. Clicking it (or a bell row) activates the capturing tab via the normal `switchTab`/`connect` path.

## Deferred: deep-conversation open

Teams' real click handler routes through `activateToast(targetEntity)`; the **test** notification is deliberately no-op'd (`id === "testNotification"` → dismiss), so the test path cannot validate navigation. There is no `<a href>` or URL in the toast, and Teams v2 keeps a single SPA URL regardless of conversation. v1 therefore stops at **activate the tab**. Deep-opening the exact conversation from a captured `targetEntity` needs validation against a *real* notification's `id` format and a working deep-link/route — deferred until then.
