// Pure screencast frame-rate throttle (fresh-frame-wins). On a slow link the remote
// browser keeps emitting frames faster than the link drains them, so a backlog forms
// and the client paints *stale* frames — the cursor lags behind reality. This decides,
// per arriving Page.screencastFrame, whether to broadcast it (true) or drop it (false);
// the relay still acks every frame so the remote keeps producing (see t054).
//
// The decision is the only pure logic in the throttle, kept here with a DI clock so it's
// unit-testable against a fake clock with zero CDP/WS dependency (ADR-0008 shared-CJS
// core). t055 reuses this to map a quality tier → target FPS — the module stays free of
// any tier/UI knowledge; it only takes a `targetFps` number. Tested by frame-throttle.test.ts.

// createFrameThrottle({ targetFps, now }) → { shouldEmit() }
//   targetFps falsy / Infinity ⇒ shouldEmit always true (no throttle, fast-LAN path)
//   now() ⇒ current time in ms (defaults to Date.now)
function createFrameThrottle({ targetFps, now = Date.now } = {}) {
  const throttled = Number.isFinite(targetFps) && targetFps > 0
  const intervalMs = throttled ? 1000 / targetFps : 0
  let lastEmit = null

  function shouldEmit() {
    if (!throttled) return true
    const t = now()
    if (lastEmit === null || t - lastEmit >= intervalMs) {
      lastEmit = t
      return true
    }
    return false
  }

  return { shouldEmit }
}

// Producer-side cap: how many source frames to skip per emitted frame, given a target
// fps and the source fps the remote browser composites at (Chromium's screencast caps
// at the page's frame rate, ~60). Floors so we never exceed the target, clamps to ≥ 1
// (Chromium rejects everyNthFrame < 1). A falsy targetFps means "no producer cap" → 1.
function everyNthFrameFor(targetFps, sourceFps = 60) {
  if (!targetFps || targetFps <= 0) return 1
  return Math.max(1, Math.floor(sourceFps / targetFps))
}

module.exports = { createFrameThrottle, everyNthFrameFor }
