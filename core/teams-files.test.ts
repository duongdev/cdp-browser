import { describe, expect, it } from "vitest"
// CommonJS module shared with web/server.mjs (which builds the sent-file descriptor server-side).
import { buildTeamsFilePayload, fileExt } from "./teams-files"

describe("fileExt", () => {
  it("lowercases the extension after the last dot", () => {
    expect(fileExt("Report.PDF")).toBe("pdf")
    expect(fileExt("photo.JPG")).toBe("jpg")
  })

  it("takes the last segment of a multi-dot name", () => {
    expect(fileExt("archive.tar.gz")).toBe("gz")
  })

  it('falls back to "file" when there is no usable extension', () => {
    expect(fileExt("README")).toBe("file")
    expect(fileExt("trailing.")).toBe("file")
    expect(fileExt(".gitignore")).toBe("file")
    expect(fileExt("")).toBe("file")
    expect(fileExt(undefined)).toBe("file")
  })
})

describe("buildTeamsFilePayload", () => {
  const base = {
    myHost: "contoso-my.sharepoint.com",
    userPath: "jane_contoso_com",
    driveItem: { id: "01ABCDEF", name: "notes.txt" },
    shareUrl: "https://contoso-my.sharepoint.com/:t:/g/personal/jane/abc",
    filename: "notes.txt",
  }

  it("tags the descriptor as a Skype File", () => {
    expect(buildTeamsFilePayload(base)["@type"]).toBe("http://schema.skype.com/File")
  })

  it("derives fileType/type from the lowercased extension", () => {
    const f = buildTeamsFilePayload({ ...base, filename: "Deck.PPTX" })
    expect(f.fileType).toBe("pptx")
    expect(f.type).toBe("pptx")
  })

  it('uses "file" as the type for an extension-less name', () => {
    const f = buildTeamsFilePayload({ ...base, filename: "LICENSE" })
    expect(f.fileType).toBe("file")
    expect(f.type).toBe("file")
  })

  it("builds objectUrl/baseUrl under the encoded SharePoint files path", () => {
    const f = buildTeamsFilePayload(base)
    expect(f.baseUrl).toBe(
      "https://contoso-my.sharepoint.com/personal/jane_contoso_com/Documents/Microsoft%20Teams%20Chat%20Files/",
    )
    expect(f.objectUrl).toBe(`${f.baseUrl}notes.txt`)
  })

  it("percent-encodes the filename in objectUrl but keeps it raw in serverRelativeUrl", () => {
    const f = buildTeamsFilePayload({ ...base, filename: "Q3 plan.docx" })
    expect(f.objectUrl).toContain("Microsoft%20Teams%20Chat%20Files/Q3%20plan.docx")
    expect(f.fileInfo.serverRelativeUrl).toBe(
      "/personal/jane_contoso_com/Documents/Microsoft Teams Chat Files/Q3 plan.docx",
    )
  })

  it("carries the share link, site url, and file url in fileInfo", () => {
    const f = buildTeamsFilePayload(base)
    expect(f.fileInfo.shareUrl).toBe(base.shareUrl)
    expect(f.fileInfo.siteUrl).toBe("https://contoso-my.sharepoint.com/personal/jane_contoso_com/")
    expect(f.fileInfo.fileUrl).toBe(f.objectUrl)
    expect(f.fileInfo.shareId).toBeNull()
  })

  it("prefers the sharepoint listItemUniqueId as the unique id, else the driveItem id", () => {
    const withSp = buildTeamsFilePayload({
      ...base,
      driveItem: { id: "01ABC", sharepointIds: { listItemUniqueId: "unique-guid" } },
    })
    expect(withSp.itemid).toBe("unique-guid")
    expect(withSp.id).toBe("unique-guid")
    expect(withSp.fileInfo.itemId).toBe("unique-guid")

    expect(buildTeamsFilePayload(base).id).toBe("01ABCDEF")
  })

  it("marks the file active with version 1 and the p2p chiclet state", () => {
    const f = buildTeamsFilePayload(base)
    expect(f.state).toBe("active")
    expect(f.version).toBe(1)
    expect(f.fileChicletState).toEqual({ serviceName: "p2p", state: "active" })
  })

  it("round-trips through JSON (properties.files rides as a JSON string)", () => {
    const f = buildTeamsFilePayload(base)
    expect(JSON.parse(JSON.stringify([f]))[0]).toEqual(f)
  })
})
