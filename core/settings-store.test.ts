import { beforeEach, describe, expect, it, vi } from "vitest"
// CommonJS settings store shared by path. Holds the settings object + an injected
// persist fn; the backend owns the actual fs write. Tested through its public API.
import { createSettingsStore } from "./settings-store"

describe("settings-store", () => {
  let persist: ReturnType<typeof vi.fn>
  beforeEach(() => {
    persist = vi.fn()
  })

  it("returns config and persists a new host/port", () => {
    const s = createSettingsStore({ initial: { host: "a", port: 1 }, persist })
    expect(s.getConfig()).toEqual({ host: "a", port: 1 })
    s.setConfig({ host: "b", port: 2 })
    expect(s.getConfig()).toEqual({ host: "b", port: 2 })
    expect(persist).toHaveBeenCalled()
  })

  it("fills ui-state defaults when settings are empty", () => {
    const s = createSettingsStore({ initial: {}, persist })
    expect(s.getUiState()).toMatchObject({
      sidebarCollapsed: false,
      pinnedOpen: true,
      adaptiveViewport: false,
      switchEffect: "blur",
      notificationsEnabled: true,
      syncTheme: true,
    })
  })

  it("merges only known ui-state keys on set", () => {
    const s = createSettingsStore({ initial: {}, persist })
    s.setUiState({ sidebarCollapsed: true, bogus: 1 })
    expect(s.getUiState().sidebarCollapsed).toBe(true)
    expect(s.getUiState()).not.toHaveProperty("bogus")
    expect(persist).toHaveBeenCalled()
  })

  it("sidebar width defaults to 220 and round-trips", () => {
    const s = createSettingsStore({ initial: {}, persist })
    expect(s.getSidebarWidth()).toBe(220)
    s.setSidebarWidth(300)
    expect(s.getSidebarWidth()).toBe(300)
  })

  it("adds a pin, deduping by url", () => {
    const s = createSettingsStore({ initial: {}, persist })
    s.addPin({ id: "1", url: "u1" })
    s.addPin({ id: "2", url: "u1" }) // dup url -> ignored
    expect(s.getPins()).toHaveLength(1)
  })

  it("updates a pin's title/url by id and removes by id", () => {
    const s = createSettingsStore({
      initial: { pins: [{ id: "1", url: "u", title: "t" }] },
      persist,
    })
    s.updatePin("1", { title: "T2", url: "u2" })
    expect(s.getPins()[0]).toMatchObject({ id: "1", title: "T2", url: "u2" })
    s.removePin("1")
    expect(s.getPins()).toEqual([])
  })

  it("partial patch with only title preserves the stored url and targetId", () => {
    const s = createSettingsStore({
      initial: { pins: [{ id: "1", url: "u", title: "t", targetId: "X" }] },
      persist,
    })
    s.updatePin("1", { title: "T2" })
    expect(s.getPins()[0]).toEqual({ id: "1", url: "u", title: "T2", targetId: "X" })
  })

  it("partial patch with only url preserves the stored title", () => {
    const s = createSettingsStore({
      initial: { pins: [{ id: "1", url: "u", title: "t" }] },
      persist,
    })
    s.updatePin("1", { url: "u2" })
    expect(s.getPins()[0]).toEqual({ id: "1", url: "u2", title: "t" })
  })

  it("merges an extra patch key through without dropping title/url", () => {
    const s = createSettingsStore({
      initial: { pins: [{ id: "1", url: "u", title: "t" }] },
      persist,
    })
    s.updatePin("1", { targetId: "X" })
    expect(s.getPins()[0]).toEqual({ id: "1", url: "u", title: "t", targetId: "X" })
  })

  it("update for an unknown id leaves all pins unchanged and still persists", () => {
    const s = createSettingsStore({
      initial: { pins: [{ id: "1", url: "u", title: "t" }] },
      persist,
    })
    s.updatePin("nope", { title: "T2" })
    expect(s.getPins()).toEqual([{ id: "1", url: "u", title: "t" }])
    expect(persist).toHaveBeenCalled()
  })

  it("reorder replaces the whole pins array (carries link/unlink changes)", () => {
    const s = createSettingsStore({ initial: { pins: [{ id: "1" }, { id: "2" }] }, persist })
    s.reorderPins([{ id: "2" }, { id: "1", targetId: "X" }])
    expect(s.getPins().map((p: { id: string }) => p.id)).toEqual(["2", "1"])
  })

  it("migrates legacy switchBlur -> switchEffect and bookmarks -> pins", () => {
    const s = createSettingsStore({
      initial: { switchBlur: true, bookmarks: [{ id: "b" }] },
      persist,
    })
    expect(s.getUiState().switchEffect).toBe("blur")
    expect(s.getPins()).toEqual([{ id: "b" }])
  })
})
