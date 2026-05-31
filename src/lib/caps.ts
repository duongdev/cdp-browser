/**
 * Build capabilities — the single source of truth for "what can this build do."
 *
 * Local <webview> tabs and unpacked MV3 extensions need a real Electron session, so they
 * exist only under Electron. The web shim installs `window.webCaps` (the restricted set);
 * Electron leaves it absent. Reading caps through one accessor — never `window.webCaps`
 * inline — lets every Electron-only feature gate at its data source instead of at each
 * render site. See docs/conventions/feature-gates.md.
 *
 * Pure: the only DOM coupling is the thin `readWebCaps` default, swappable in tests.
 */

export interface WebCaps {
  /** True in the browser build. */
  web: boolean
  /** Local <webview> tabs — Electron only. */
  localTabs: boolean
  /** Unpacked MV3 extensions — Electron only. */
  extensions: boolean
}

/** The restricted set the web shim installs as `window.webCaps`. */
export const DEFAULT_CAPS: WebCaps = { web: true, localTabs: false, extensions: false }

/** Full capability — the implicit Electron build, where `window.webCaps` is absent. */
const ELECTRON_CAPS: WebCaps = { web: false, localTabs: true, extensions: true }

const readWebCaps = (): WebCaps | undefined =>
  typeof window !== "undefined" ? window.webCaps : undefined

/**
 * Resolve the active build's capabilities. `read` is injectable for tests; production
 * reads `window.webCaps` — present (restricted) on web, absent (full) under Electron.
 */
export function getCaps(read: () => WebCaps | undefined = readWebCaps): WebCaps {
  return read() ?? ELECTRON_CAPS
}
