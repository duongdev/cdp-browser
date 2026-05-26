import { describe, expect, it } from "vitest"
// CommonJS module shared by path with any CDP backend (web proxy, and later main.js).
import { activate, close, list, newTab, version } from "./cdp-endpoints"

describe("cdp-endpoints", () => {
  it("builds the /json list endpoint as a GET", () => {
    expect(list("localhost", 9222)).toEqual({ url: "http://localhost:9222/json", method: "GET" })
  })

  it("builds /json/new as a PUT (Edge requires PUT, Chrome tolerates it)", () => {
    expect(newTab("h", 1, "https://example.com")).toEqual({
      url: "http://h:1/json/new?https://example.com",
      method: "PUT",
    })
  })

  it("defaults a new tab with no url to about:blank", () => {
    expect(newTab("h", 1).url).toBe("http://h:1/json/new?about:blank")
  })

  it("builds close/activate by target id", () => {
    expect(close("h", 1, "ABC").url).toBe("http://h:1/json/close/ABC")
    expect(activate("h", 1, "ABC").url).toBe("http://h:1/json/activate/ABC")
  })

  it("builds the version probe endpoint", () => {
    expect(version("h", 1).url).toBe("http://h:1/json/version")
  })
})
