import { describe, expect, it } from "vitest"
import {
  type ChatSettings,
  DEFAULT_CHAT_SETTINGS,
  deviceKey,
  readChatSettings,
  resolveDark,
  writeChatSettings,
} from "./chat-settings"

const DEV = "device_abc"

describe("readChatSettings", () => {
  it("returns defaults for an empty ui-state", () => {
    expect(readChatSettings({}, DEV)).toEqual(DEFAULT_CHAT_SETTINGS)
  })

  it("reads this device's slots", () => {
    const ui = { chatTheme_device_abc: "dark", chatDensity_device_abc: "compact" }
    expect(readChatSettings(ui, DEV)).toEqual<ChatSettings>({ theme: "dark", density: "compact" })
  })

  it("ignores another device's slots", () => {
    const ui = { chatTheme_other: "dark", chatDensity_other: "compact" }
    expect(readChatSettings(ui, DEV)).toEqual(DEFAULT_CHAT_SETTINGS)
  })

  it("falls back to defaults on garbage values", () => {
    const ui = { chatTheme_device_abc: "neon", chatDensity_device_abc: 3 }
    expect(readChatSettings(ui, DEV)).toEqual(DEFAULT_CHAT_SETTINGS)
  })
})

describe("writeChatSettings", () => {
  it("emits only present keys, device-suffixed", () => {
    expect(writeChatSettings({ theme: "light" }, DEV)).toEqual({ chatTheme_device_abc: "light" })
    expect(writeChatSettings({ density: "compact" }, DEV)).toEqual({
      chatDensity_device_abc: "compact",
    })
  })

  it("emits both when both present", () => {
    expect(writeChatSettings({ theme: "dark", density: "compact" }, DEV)).toEqual({
      chatTheme_device_abc: "dark",
      chatDensity_device_abc: "compact",
    })
  })

  it("emits nothing for an empty partial", () => {
    expect(writeChatSettings({}, DEV)).toEqual({})
  })
})

describe("deviceKey", () => {
  it("joins base + deviceId", () => {
    expect(deviceKey("chatTheme", DEV)).toBe("chatTheme_device_abc")
  })
})

describe("resolveDark", () => {
  it("system follows the OS", () => {
    expect(resolveDark("system", true)).toBe(true)
    expect(resolveDark("system", false)).toBe(false)
  })
  it("explicit light/dark ignore the OS", () => {
    expect(resolveDark("light", true)).toBe(false)
    expect(resolveDark("dark", false)).toBe(true)
  })
})
