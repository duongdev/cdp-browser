// Sent-file content builder for the Teams chat backend (t124, ADR-0018). A non-image file
// pasted/picked in the composer is uploaded to the user's SharePoint "Microsoft Teams Chat Files"
// folder (PUT bytes → createLink, IN-PAGE), then posted as a RichText/Html message whose
// properties.files carries this one SharePoint file descriptor — Teams renders the chip from it,
// and the read path (core/teams-render.js:parseFiles) turns the same shape back into a chip. This
// module is the pure builder for that descriptor (the effectful upload/send live in web/server.mjs).
// Tested by teams-files.test.ts.

// Lowercased file extension after the LAST dot, else "file" — a name with no dot, a leading-dot
// hidden name (".gitignore"), or a trailing dot ("x.") has no usable extension.
function fileExt(filename) {
  const name = String(filename ?? "")
  const dot = name.lastIndexOf(".")
  if (dot <= 0 || dot === name.length - 1) return "file"
  return name.slice(dot + 1).toLowerCase()
}

// The fixed personal-drive folder every Teams chat upload lands in.
const FILES_FOLDER = "Microsoft Teams Chat Files"

// Build the ONE properties.files descriptor for an uploaded SharePoint file. `driveItem` is the
// v2.0 upload response (its `id`; `sharepointIds.listItemUniqueId` when present is the preferred
// unique id — the v2.0 upload response usually omits sharepointIds, so `id` is the fallback).
// `shareUrl` is the organization view link from createLink. objectUrl/baseUrl are percent-encoded;
// serverRelativeUrl is the RAW (un-encoded) site path Teams keys on. Deterministic — no I/O.
function buildTeamsFilePayload({ myHost, userPath, driveItem, shareUrl, filename } = {}) {
  const uniqueId = driveItem?.sharepointIds?.listItemUniqueId || driveItem?.id
  const ext = fileExt(filename)
  const baseUrl = `https://${myHost}/personal/${userPath}/Documents/${encodeURIComponent(FILES_FOLDER)}/`
  const objectUrl = `${baseUrl}${encodeURIComponent(filename)}`
  return {
    "@type": "http://schema.skype.com/File",
    itemid: uniqueId,
    id: uniqueId,
    fileName: filename,
    title: filename,
    fileType: ext,
    type: ext,
    state: "active",
    version: 1,
    objectUrl,
    baseUrl,
    fileInfo: {
      itemId: uniqueId,
      fileUrl: objectUrl,
      siteUrl: `https://${myHost}/personal/${userPath}/`,
      serverRelativeUrl: `/personal/${userPath}/Documents/${FILES_FOLDER}/${filename}`,
      shareUrl,
      shareId: null,
    },
    fileChicletState: { serviceName: "p2p", state: "active" },
  }
}

module.exports = { buildTeamsFilePayload, fileExt }
