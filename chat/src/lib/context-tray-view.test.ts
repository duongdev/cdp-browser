import { describe, expect, it } from "vitest"
import type { AssistantContextRef } from "./assistant-client"
import { defaultTrayOpen, summarizeRefs } from "./context-tray-view"

const chat = (id: string): AssistantContextRef => ({
  service: "teams",
  kind: "chat",
  convId: id,
  title: id,
  deepLink: "",
})
const message = (id: string): AssistantContextRef => ({ ...chat(id), kind: "message", msgId: "m1" })
const folder = (name: string): AssistantContextRef => ({
  service: "teams",
  kind: "folder",
  name,
  title: name,
  deepLink: "",
})
const label = (name: string): AssistantContextRef => ({ ...folder(name), kind: "label" })

describe("summarizeRefs", () => {
  it("pluralises per kind and keeps a stable order", () => {
    expect(summarizeRefs([chat("a"), chat("b"), folder("F"), message("c"), label("L")])).toBe(
      "2 chats · 1 message · 1 folder · 1 label",
    )
  })
  it("omits kinds that aren't attached", () => {
    expect(summarizeRefs([folder("F")])).toBe("1 folder")
    expect(summarizeRefs([chat("a")])).toBe("1 chat")
  })
  it("empty tray summarises to nothing", () => {
    expect(summarizeRefs([])).toBe("")
  })
})

describe("defaultTrayOpen", () => {
  it("shows one or two chips, collapses a pile", () => {
    expect(defaultTrayOpen(1)).toBe(true)
    expect(defaultTrayOpen(2)).toBe(true)
    expect(defaultTrayOpen(3)).toBe(false)
  })
  it("an empty tray is not open (it renders nothing)", () => {
    expect(defaultTrayOpen(0)).toBe(false)
  })
})
