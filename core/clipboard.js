/**
 * Clipboard utilities for CDP Browser.
 * Pure, backend-agnostic. Used by main.js and web/server.mjs.
 */

/**
 * Builds the Browser.grantPermissions payload, attempting new permission names
 * first, with fallback to legacy names on error.
 *
 * Modern Chromium/Edge (e.g. Edge 148) uses clipboardRead/clipboardWrite;
 * older builds used clipboardReadWrite/clipboardSanitizedWrite. This helper
 * will return the modern names; callers must catch error -32602 (Unknown permission type)
 * and retry with the legacy payload.
 *
 * @param {string} [origin] - Optional origin to scope permissions. If omitted, applies to all.
 * @returns {{origin?: string, permissions: string[]}} Payload for Browser.grantPermissions.
 */
function buildClipboardPermissionsModern(origin) {
  const payload = {
    permissions: ["clipboardRead", "clipboardWrite"],
  }
  if (origin) {
    payload.origin = origin
  }
  return payload
}

/**
 * Legacy fallback payload for older Chromium builds.
 *
 * @param {string} [origin]
 * @returns {{origin?: string, permissions: string[]}}
 */
function buildClipboardPermissionsLegacy(origin) {
  const payload = {
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  }
  if (origin) {
    payload.origin = origin
  }
  return payload
}

/**
 * Determines which paste route to use based on the remote focus descriptor.
 *
 * @param {Object} focusDescriptor - Information about what element has focus on the remote.
 * @param {boolean} focusDescriptor.isContentEditable - True if focused element is contenteditable or a rich editor.
 * @param {boolean} focusDescriptor.isRichEditor - True if in a known rich-editor context (Gmail, Docs, etc).
 * @returns {Object} Paste route directive.
 * @returns {string} .route - Either 'insertText' (plain) or 'preseed' (rich).
 * @returns {string} .reason - Human-readable explanation.
 */
/**
 * Minimal extension → MIME map for clipboard file paste. Covers the file kinds a
 * user is likely to copy-paste into a remote page (images + video + a few docs);
 * anything unknown falls back to application/octet-stream so the remote `File`
 * still carries bytes + a name (the target site sniffs content / extension).
 *
 * The map is the source of truth for paste mime — `clipboard.readImage()` only
 * yields a thumbnail icon for a copied *file*, so the file path is read directly
 * and its type derived from the name here.
 *
 * @param {string} name - File name or path.
 * @returns {string} MIME type.
 */
function mimeForName(name) {
  const ext = String(name || "")
    .toLowerCase()
    .split(".")
    .pop()
  const map = {
    // images
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    heic: "image/heic",
    avif: "image/avif",
    // video
    mp4: "video/mp4",
    m4v: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
    // audio
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
    // docs
    pdf: "application/pdf",
    txt: "text/plain",
    zip: "application/zip",
  }
  return (ext && map[ext]) || "application/octet-stream"
}

function selectPasteRoute(focusDescriptor) {
  const { isContentEditable = false, isRichEditor = false } = focusDescriptor || {}

  if (isContentEditable || isRichEditor) {
    return {
      route: "preseed",
      reason:
        "Rich editor detected (contenteditable/onpaste handler); pre-seed clipboard + forward Cmd+V",
    }
  }

  return {
    route: "insertText",
    reason: "Plain input; use Input.insertText for direct text insertion",
  }
}

module.exports = {
  buildClipboardPermissionsModern,
  buildClipboardPermissionsLegacy,
  mimeForName,
  selectPasteRoute,
}
