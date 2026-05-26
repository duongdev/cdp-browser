import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./app"
import { installWebRuntimeIfNeeded } from "./lib/cdp-web-transport"

// In the browser (no Electron preload) install the HTTP/SSE transport before mount.
installWebRuntimeIfNeeded()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
