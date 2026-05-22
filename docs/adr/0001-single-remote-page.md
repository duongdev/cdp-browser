# Exactly one Remote Page at a time

CDP only streams `Page.startScreencast` frames for the **Active Tab** on the remote browser, and only one debugger session may attach to a target at a time. We therefore keep exactly one live **Remote Page** (one WebSocket, owned in the main process): switching the Active Tab tears down the old connection and opens a new one. The renderer-side Remote Page module is deliberately single-session — there is no multi-session API, split view, or simultaneous per-tab screencast.

## Consequences

A future architecture review may be tempted to add multiple concurrent Remote Pages (split view, picture-in-picture). Don't, without revisiting this: it contradicts CDP's active-tab-only screencast and single-session-per-target constraints, so it would require a fundamentally different rendering strategy, not just relaxing the module's interface.
