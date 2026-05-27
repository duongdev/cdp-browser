import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./app"
import { installWebRuntimeIfNeeded } from "./lib/cdp-web-transport"

// In the browser (no Electron preload) install the HTTP/SSE transport before mount —
// async because the E2E passphrase + key must be established before the app connects.
installWebRuntimeIfNeeded().then(() => {
  // Register the service worker for PWA install (web build only, not under Electron).
  if (window.webCaps && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {})
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
