// Derive a filesystem-safe kebab-case slug. Vietnamese (and other Latin)
// diacritics fold to ASCII so slugs stay portable; đ/Đ need an explicit map
// because NFD does not decompose them.

const COMBINING_MARKS = /\p{M}/gu

/**
 * @param {string} input
 * @param {{maxLen?: number}} [opts]
 * @returns {string} kebab-case ASCII slug, never leading/trailing '-'
 */
export function slug(input, { maxLen = 50 } = {}) {
  const folded = String(input)
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  const out = folded.slice(0, maxLen).replace(/-+$/g, "")
  // Scripts that don't fold to ASCII (e.g. a CJK-only title) would otherwise
  // yield an empty slug and a filename like `004-.md`. Fall back to a
  // placeholder the author renames.
  return out || "untitled"
}
