import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ChatApp } from "./chat-app"

// Pre-paint theme: apply the OS preference before React mounts so there's no flash. useChatSettings
// (t154) then loads the persisted theme/density from server ui-state and takes over (system keeps
// following the OS; explicit light/dark override it).
document.documentElement.classList.toggle(
  "dark",
  window.matchMedia("(prefers-color-scheme: dark)").matches,
)

// Path-scoped service worker (ADR-0019 decision 12) — installs the chat app as a distinct
// PWA under /chat/ without touching the browser PWA's SW at /.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/chat/sw.js").catch(() => null)
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delayDuration={300}>
      <ChatApp />
    </TooltipProvider>
  </StrictMode>,
)
