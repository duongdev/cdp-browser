# Adaptive Viewport sizing via device-metrics override

To remove the letterbox bars (Viewport Transform), an optional **Adaptive Viewport** mode resizes the *remote page itself* to the canvas aspect with `Emulation.setDeviceMetricsOverride`, instead of fitting a fixed-aspect Screencast Frame into the canvas. The renderer computes the override from the live canvas (CSS pixels) and pushes it; the main process caches the last override and re-applies it on every (re)connect **before** `Page.startScreencast`, so a tab switch lands already-sized — no native-size first frame and the resulting jiggle.

Because the override mutates the Remote Browser globally, it must be cleared when we let go: on tab-switch teardown and quit the main process sends `Emulation.clearDeviceMetricsOverride`; toggling the setting off clears immediately. A host-side window resize (the human taking over the machine directly) is detected by polling `Browser.getWindowForTarget` — which reports the real OS window even while emulation is active — and backs off: the override is cleared and the mode goes dormant until the user re-enables it (which surfaces as the setting toggling itself off).

A tab switch freezes the last frame until the new tab is ready (adaptive: the reflow's frames go quiet; otherwise: the first frame of the new connection), optionally with a blur "focus pull". Frames arriving in the click→connect gap are ignored as stale.

## Rejected: one WebSocket per Tab

Considered to avoid the tab-switch reconnect entirely. Rejected — it contradicts ADR 0001 and buys nothing: CDP only streams screencast for the **Active Tab**, so background sessions produce no live frames, and holding overrides on multiple tabs at once enlarges the switch-back cleanup surface. The reconnect jiggle is instead solved by the main-process override cache above.

## Known limitation: screencast is CSS-resolution (soft on retina)

`Page.startScreencast` streams frames at the **CSS viewport size**, ignoring `deviceScaleFactor` (verified on Chrome and Edge: factor 2 or 3 still yields CSS-pixel frames). On a high-DPI canvas these are upscaled and look soft. `Page.captureScreenshot` *is* device-resolution and sharp, but it cannot be streamed affordably (full-frame encode lags input) and uses a different capture path with a visible color/gamma shift, so mixing it in caused a sharp↔blur flicker on every switch. We removed it entirely and pinned `deviceScaleFactor` to 1 (the screencast discards anything higher), accepting uniform softness over inconsistency.

Crisp live rendering would require either a device-resolution streaming source CDP doesn't offer, or rendering the page at device-pixel dimensions with a counter-scale (distorts responsive layout). If revisited, an explicit **manual** "sharpen" action (one on-demand `captureScreenshot`) is the only low-risk option — automatic per-idle sharpening was tried and rejected (cursor lag + flicker).
