/**
 * Reserved combos are neither forwarded nor preventDefaulted — they fall through to
 * the macOS menu roles (Hide, Minimize, Quit, …) defined in main.js.
 */

export interface KeyLike {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  // Physical key code, not `key`: Option rewrites the produced character
  // (Opt+H → "˙"), so Cmd+Opt+H would never match on `key`.
  code: string
}

export function isOsReservedKey(e: KeyLike): boolean {
  if (!e.metaKey) return false
  if (e.altKey) return e.code === "KeyH" // Cmd+Opt+H — hide others
  if (e.ctrlKey) return e.code === "KeyF" // Ctrl+Cmd+F — toggle fullscreen
  if (e.shiftKey) return e.code === "Backquote" // Cmd+Shift+` — previous window
  return e.code === "KeyH" || e.code === "KeyM" || e.code === "KeyQ" || e.code === "Backquote"
}
