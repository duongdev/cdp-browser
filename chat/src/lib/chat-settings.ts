// Pure owner of the chat app's device-persisted settings (t154, Workstream F). Theme + density
// only (grilled #4); the push toggle lives in NotifyToggle, not here. Persisted per device in
// server ui-state under `<base>_<deviceId>` (like the / build's device-prefs.ts, t100) so they
// survive an iPad-PWA localStorage wipe. This module owns the defaults, the parse-guards, the
// ui-state key remap, and the theme resolution — all pure. Effects (fetch, DOM class, matchMedia
// subscription) live in useChatSettings + main.tsx.

export type ChatTheme = "system" | "light" | "dark"
export type ChatDensity = "comfortable" | "compact"
// UI/body typeface + code typeface. Values are the data-font / data-mono attribute strings the CSS
// switches on (see chat/src/index.css). "svn-gilroy" / "maple" are the defaults (no attribute).
export type ChatFont =
  | "svn-gilroy"
  | "anthropic-sans"
  | "anthropic-serif"
  | "manrope"
  | "inter"
  | "geist"
  | "roboto"
  | "system"
export type ChatMono = "maple" | "anthropic-mono" | "dm-mono" | "geist-mono" | "system-mono"
// Name display preference (t161): how person names render (see display-name.ts formatName).
export type ChatNameDisplay = "full" | "first" | "regex"
// Notification sound played on incoming message (PSN-98, Workstream C).
export type ChatNotifySound = "none" | "tap" | "polite" | "calm"

export interface ChatSettings {
  theme: ChatTheme
  density: ChatDensity
  font: ChatFont
  mono: ChatMono
  nameDisplay: ChatNameDisplay
  /** The strip pattern for nameDisplay "regex"; ignored otherwise. */
  nameRegex: string
  notifySound: ChatNotifySound
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  theme: "system",
  density: "comfortable",
  font: "svn-gilroy",
  mono: "maple",
  nameDisplay: "full",
  nameRegex: "",
  notifySound: "polite",
}

// The ui-state base key names. Each persists as `<base>_<deviceId>`; the server allows them
// through its DEVICE_KEY_PREFIXES gate (core/settings-store.js).
export const CHAT_THEME_BASE = "chatTheme"
export const CHAT_DENSITY_BASE = "chatDensity"
export const CHAT_FONT_BASE = "chatFont"
export const CHAT_MONO_BASE = "chatMono"
export const CHAT_NAME_DISPLAY_BASE = "chatNameDisplay"
export const CHAT_NAME_REGEX_BASE = "chatNameRegex"
export const CHAT_NOTIFY_SOUND_BASE = "chatNotifySound"

const THEMES: ChatTheme[] = ["system", "light", "dark"]
const DENSITIES: ChatDensity[] = ["comfortable", "compact"]
const FONTS: ChatFont[] = [
  "svn-gilroy",
  "anthropic-sans",
  "anthropic-serif",
  "manrope",
  "inter",
  "geist",
  "roboto",
  "system",
]
const MONOS: ChatMono[] = ["maple", "anthropic-mono", "dm-mono", "geist-mono", "system-mono"]

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

function parseFont(raw: unknown): ChatFont {
  return typeof raw === "string" && (FONTS as string[]).includes(raw)
    ? (raw as ChatFont)
    : DEFAULT_CHAT_SETTINGS.font
}

function parseMono(raw: unknown): ChatMono {
  return typeof raw === "string" && (MONOS as string[]).includes(raw)
    ? (raw as ChatMono)
    : DEFAULT_CHAT_SETTINGS.mono
}

const NAME_DISPLAYS: ChatNameDisplay[] = ["full", "first", "regex"]

function parseNameDisplay(raw: unknown): ChatNameDisplay {
  return typeof raw === "string" && (NAME_DISPLAYS as string[]).includes(raw)
    ? (raw as ChatNameDisplay)
    : DEFAULT_CHAT_SETTINGS.nameDisplay
}

function parseNameRegex(raw: unknown): string {
  return typeof raw === "string" ? raw : ""
}

const NOTIFY_SOUNDS: ChatNotifySound[] = ["none", "tap", "polite", "calm"]

export function parseNotifySound(raw: unknown): ChatNotifySound {
  return typeof raw === "string" && (NOTIFY_SOUNDS as string[]).includes(raw)
    ? (raw as ChatNotifySound)
    : DEFAULT_CHAT_SETTINGS.notifySound
}

export function deviceKey(base: string, deviceId: string): string {
  return `${base}_${deviceId}`
}

/** Resolve this device's chat settings from a ui-state snapshot. Missing/garbage → defaults. */
export function readChatSettings(ui: Record<string, unknown>, deviceId: string): ChatSettings {
  return {
    theme: parseTheme(ui[deviceKey(CHAT_THEME_BASE, deviceId)]),
    density: parseDensity(ui[deviceKey(CHAT_DENSITY_BASE, deviceId)]),
    font: parseFont(ui[deviceKey(CHAT_FONT_BASE, deviceId)]),
    mono: parseMono(ui[deviceKey(CHAT_MONO_BASE, deviceId)]),
    nameDisplay: parseNameDisplay(ui[deviceKey(CHAT_NAME_DISPLAY_BASE, deviceId)]),
    nameRegex: parseNameRegex(ui[deviceKey(CHAT_NAME_REGEX_BASE, deviceId)]),
    notifySound: parseNotifySound(ui[deviceKey(CHAT_NOTIFY_SOUND_BASE, deviceId)]),
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
  if (partial.font !== undefined) out[deviceKey(CHAT_FONT_BASE, deviceId)] = partial.font
  if (partial.mono !== undefined) out[deviceKey(CHAT_MONO_BASE, deviceId)] = partial.mono
  if (partial.nameDisplay !== undefined)
    out[deviceKey(CHAT_NAME_DISPLAY_BASE, deviceId)] = partial.nameDisplay
  if (partial.nameRegex !== undefined)
    out[deviceKey(CHAT_NAME_REGEX_BASE, deviceId)] = partial.nameRegex
  if (partial.notifySound !== undefined)
    out[deviceKey(CHAT_NOTIFY_SOUND_BASE, deviceId)] = partial.notifySound
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
