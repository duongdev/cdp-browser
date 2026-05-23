import { existsSync } from "node:fs"
import { join } from "node:path"

// Resolve a non-colliding file path. First choice is `<dir>/<base><ext>`;
// on collision append `-2`, `-3`, … The `exists` seam keeps it unit-testable
// without touching the real filesystem.

/**
 * @param {string} dir
 * @param {string} base   slug without extension
 * @param {string} ext    including the dot, e.g. ".md"
 * @param {{exists?: (p: string) => boolean}} [opts]
 * @returns {string} a path that does not currently exist
 */
export function findUniquePath(dir, base, ext, { exists = existsSync } = {}) {
  let candidate = join(dir, `${base}${ext}`)
  let n = 1
  while (exists(candidate)) {
    n += 1
    candidate = join(dir, `${base}-${n}${ext}`)
  }
  return candidate
}
