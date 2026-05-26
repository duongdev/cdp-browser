// Settings store shared by path between the web proxy and (later) main.js. Holds
// the in-memory settings object and calls an injected `persist(settings)` on every
// mutation — the backend owns the actual fs write. No fs, no Electron here, so it
// is unit-testable. Schema matches Electron's settings.json. Tested by
// settings-store.test.ts.

// The ui-state keys the renderer reads, with their defaults. `localExtensionPaths`
// and the local-media flags are Electron-only but kept for schema parity.
const UI_DEFAULTS = {
  sidebarCollapsed: false,
  pinnedOpen: true,
  adaptiveViewport: false,
  forceOnClient: false,
  switchEffect: "blur",
  notificationsEnabled: true,
  syncTheme: true,
  autoGrantLocalMedia: true,
  restoreLocalPins: true,
  localExtensionPaths: [],
}
// Keys settable via setUiState (localExtensionPaths is owned by extension flows).
const UI_SETTABLE = Object.keys(UI_DEFAULTS).filter((k) => k !== "localExtensionPaths")

// One-time migrations mirroring main.js: legacy boolean switchBlur -> switchEffect
// enum, and legacy bookmarks -> pins (a pin is a superset of a bookmark).
function migrate(s) {
  if (s.switchEffect === undefined && s.switchBlur !== undefined) {
    s.switchEffect = s.switchBlur ? "blur" : "none"
    delete s.switchBlur
  }
  if (s.pins === undefined && s.bookmarks !== undefined) {
    s.pins = s.bookmarks
    delete s.bookmarks
  }
  return s
}

function createSettingsStore({ initial, persist }) {
  const settings = migrate({ ...initial })
  const save = () => persist(settings)

  return {
    raw: () => settings,

    getConfig: () => ({ host: settings.host, port: settings.port }),
    setConfig: ({ host, port }) => {
      settings.host = host
      settings.port = port
      save()
    },

    getSidebarWidth: () => settings.sidebarWidth ?? 220,
    setSidebarWidth: (width) => {
      settings.sidebarWidth = width
      save()
    },

    getUiState: () => {
      const out = {}
      for (const k of Object.keys(UI_DEFAULTS)) out[k] = settings[k] ?? UI_DEFAULTS[k]
      return out
    },
    setUiState: (partial) => {
      for (const k of UI_SETTABLE) if (k in partial) settings[k] = partial[k]
      save()
    },

    getThemeSource: () => settings.themeSource || "system",
    setThemeSource: (source) => {
      settings.themeSource = source
      save()
    },

    getPins: () => settings.pins || [],
    addPin: (pin) => {
      if (!settings.pins) settings.pins = []
      if (!settings.pins.some((p) => p.url === pin.url)) {
        settings.pins.push(pin)
        save()
      }
      return settings.pins
    },
    updatePin: (id, patch) => {
      settings.pins = (settings.pins || []).map((p) =>
        p.id === id ? { ...p, title: patch.title, url: patch.url } : p,
      )
      save()
      return settings.pins
    },
    removePin: (id) => {
      settings.pins = (settings.pins || []).filter((p) => p.id !== id)
      save()
      return settings.pins
    },
    reorderPins: (pins) => {
      settings.pins = pins
      save()
      return settings.pins
    },
  }
}

module.exports = { createSettingsStore, UI_DEFAULTS }
