// Pure owner of the chat app's device-persisted settings (t154, Workstream F). Theme + density
// only (grilled #4); the push toggle lives in NotifyToggle, not here. Persisted per device in
// server ui-state under `<base>_<deviceId>` (like the / build's device-prefs.ts, t100) so they
// survive an iPad-PWA localStorage wipe. This module owns the defaults, the parse-guards, the
// ui-state key remap, and the theme resolution — all pure. Effects (fetch, DOM class, matchMedia
// subscription) live in useChatSettings + main.tsx.

export type ChatTheme = "system" | "light" | "dark"
export type ChatDensity = "comfortable" | "compact"

export interface ChatSettings {
  theme: ChatTheme
  density: ChatDensity
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  theme: "system",
  density: "comfortable",
}

// The ui-state base key names. Each persists as `<base>_<deviceId>`; the server allows them
// through its DEVICE_KEY_PREFIXES gate (core/settings-store.js).
export const CHAT_THEME_BASE = "chatTheme"
export const CHAT_DENSITY_BASE = "chatDensity"

const THEMES: ChatTheme[] = ["system", "light", "dark"]
const DENSITIES: ChatDensity[] = ["comfortable", "compact"]

function parseTheme(raw: unknown): ChatTheme {
  return typeof raw === "string" && (THEMES as string[]).includes(raw)
    ? (raw as ChatTheme)
    : DEFAULT_CHAT_SETTINGS.theme
}

function parseDensity(raw: unknown): ChatDensity {
  return typeof raw === "string" && (DENSITIES as string[]).includes(raw)
    ? (raw as ChatDensity)
    : DEFAULT_CHAT_SETTINGS.density
}

export function deviceKey(base: string, deviceId: string): string {
  return `${base}_${deviceId}`
}

/** Resolve this device's chat settings from a ui-state snapshot. Missing/garbage → defaults. */
export function readChatSettings(ui: Record<string, unknown>, deviceId: string): ChatSettings {
  return {
    theme: parseTheme(ui[deviceKey(CHAT_THEME_BASE, deviceId)]),
    density: parseDensity(ui[deviceKey(CHAT_DENSITY_BASE, deviceId)]),
  }
}

/** Build the ui-state partial to POST for a settings change — only the keys present in `partial`,
 *  each to its `<base>_<deviceId>` slot. */
export function writeChatSettings(
  partial: Partial<ChatSettings>,
  deviceId: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (partial.theme !== undefined) out[deviceKey(CHAT_THEME_BASE, deviceId)] = partial.theme
  if (partial.density !== undefined) out[deviceKey(CHAT_DENSITY_BASE, deviceId)] = partial.density
  return out
}

/** Whether dark styling should be on, given the theme setting + the OS preference. `system` follows
 *  the OS (the current pre-t154 behaviour); explicit light/dark ignores it. Pure — the caller reads
 *  `matchMedia` and toggles the `.dark` class. */
export function resolveDark(theme: ChatTheme, systemPrefersDark: boolean): boolean {
  if (theme === "light") return false
  if (theme === "dark") return true
  return systemPrefersDark
}
