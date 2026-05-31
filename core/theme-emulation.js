// Pure theme-sync logic shared by main.js (effects: the CDP WebSocket send lives in
// main.js). Mirrors the "pure reducer, effects in caller" pattern of notifications.js,
// as CommonJS since the Electron main process can't import the renderer's TS/ESM modules.
// Tested by theme-emulation.test.ts.

// Maps the sync setting + resolved app darkness to `Emulation.setEmulatedMedia` params.
// When sync is off we return {} — resetting emulation so the page falls back to whatever
// the host browser reports, rather than forcing a scheme.
function emulatedMediaParams(syncTheme, dark) {
  if (!syncTheme) return {}
  return { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] }
}

module.exports = { emulatedMediaParams }
