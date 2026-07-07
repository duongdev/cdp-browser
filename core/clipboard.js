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
export function buildClipboardPermissionsModern(origin) {
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
export function buildClipboardPermissionsLegacy(origin) {
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
 * @returns {{route: string, reason: string}} Paste route directive — `route` is
 *   'insertText' (plain) or 'preseed' (rich); `reason` is a human-readable explanation.
 */
export function selectPasteRoute(focusDescriptor) {
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
