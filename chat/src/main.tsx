import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import { ChatApp } from "./chat-app"

// Theme follows the OS (mirrors the web build's matchMedia default — ADR-0006). The shared
// theme keys dark styling off a `.dark` class on the root, so track the media query.
const dark = window.matchMedia("(prefers-color-scheme: dark)")
const applyTheme = () => document.documentElement.classList.toggle("dark", dark.matches)
applyTheme()
dark.addEventListener("change", applyTheme)

// Path-scoped service worker (ADR-0018 decision 12) — installs the chat app as a distinct
// PWA under /chat/ without touching the browser PWA's SW at /.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/chat/sw.js").catch(() => null)
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ChatApp />
  </StrictMode>,
)
