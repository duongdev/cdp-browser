// Compute the next zero-padded sequence number from a set of existing strings.
// Order-independent: parses every match and takes max+1, never relies on
// count or input order (R-NNN entries in risks.md are demonstrably unordered).

/**
 * @param {Iterable<string>} existing  strings to scan (filenames, headings…)
 * @param {{pattern: RegExp, pad: number}} opts
 *   pattern: must expose the number in capture group 1
 *   pad: target width of the returned string
 * @returns {string} next number, zero-padded to `pad`
 */
export function nextNumber(existing, { pattern, pad }) {
  let max = 0
  for (const s of existing) {
    const m = String(s).match(pattern)
    if (m) {
      const n = Number.parseInt(m[1], 10)
      if (Number.isFinite(n) && n > max) max = n
    }
  }
  return String(max + 1).padStart(pad, "0")
}
