import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./app"
import { initAppHeight } from "./lib/app-height"
import { installWebRuntimeIfNeeded } from "./lib/cdp-web-transport"
import { initPointerModality } from "./lib/pointer-modality"
import { setSwRegistration } from "./lib/sw-update"

// Set the runtime input-modality class before first paint so the touch-target system
// is correct on load (and re-flips live when the actual pointer changes).
initPointerModality()
// Pin full-viewport height to live innerHeight — fixes the iOS standalone bottom blank
// that a manual window resize otherwise clears.
initAppHeight()

// In the browser (no Electron preload) install the HTTP/SSE transport before mount —
// async because the E2E passphrase + key must be established before the app connects.
// Mount on `.finally`, not `.then`: a rejected/failed runtime init must never leave the
// screen blank. installWebRuntimeIfNeeded sets window.cdp even on bootstrap failure, so the
// app renders and surfaces real connection state instead of a white void.
installWebRuntimeIfNeeded()
  .catch((e) => console.error("[boot] web runtime init failed; mounting anyway:", e))
  .finally(() => {
    // Register the service worker for PWA install (web build only, not under Electron).
    // The build identity rides in the query param so a new build is a new script URL
    // (forces an SW update) and names a per-build cache (sw.js). See t044.
    if (window.webCaps && "serviceWorker" in navigator) {
      setSwRegistration(
        navigator.serviceWorker
          .register(`/sw.js?v=${__APP_VERSION__}-${__GIT_SHA__}`)
          .catch(() => null),
      )
    }
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  })
