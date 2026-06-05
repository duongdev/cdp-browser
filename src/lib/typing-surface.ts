export type ActiveKind = "cdp" | "local" | "chrome"

/**
 * Returns true when the active surface (remote page or local webview) is a typing surface,
 * so bare-character shortcuts should be forwarded instead of handled by the app.
 * Only pure text-entry surfaces: activeKind must be 'cdp' or 'local'. App chrome ('chrome')
 * returns false — shortcuts fire there.
 */
export function isTypingSurface(activeKind: ActiveKind): boolean {
  return activeKind === "cdp" || activeKind === "local"
}
