// Pure helpers for the standalone Teams Chat Electron shell (chat-main.js):
// server-URL resolution + external-link classification. Kept pure + testable;
// the effectful window/shell wiring lives in chat-main.js.

// Precedence: env override > stored config > built-in default. Trailing slashes
// are trimmed so `${url}/chat/` never doubles up.
function resolveServerUrl(env, stored, fallback) {
  const raw = env || stored || fallback
  return String(raw).replace(/\/+$/, "")
}

// True when a navigation target leaves the chat server's origin — those open in
// the OS browser instead of inside the shell. A malformed URL is treated as
// external (safer: it leaves the shell).
function isExternalUrl(url, serverUrl) {
  try {
    return new URL(url).origin !== new URL(serverUrl).origin
  } catch {
    return true
  }
}

// True when a URL is a same-origin SPA route inside the shell (starts with /chat).
// The Electron will-navigate / setWindowOpenHandler use this to distinguish an
// in-app deep link (a message link from the renderer) from an external link that
// should bounce to the OS browser. A foreign-origin URL is never a chat route,
// even if the path matches.
function isChatRoute(url, serverUrl) {
  try {
    const u = new URL(url)
    return u.origin === new URL(serverUrl).origin && u.pathname.startsWith("/chat")
  } catch {
    return false
  }
}

module.exports = { resolveServerUrl, isExternalUrl, isChatRoute }
