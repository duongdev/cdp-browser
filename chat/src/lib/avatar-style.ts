// Pure avatar helpers (C1). Framework-free, deterministic — same seed → same result.

// Ten mid/deep-saturated hues: light-mode and dark-mode friendly with white text.
// Expressed as HSL so we can pair them as gradient pairs by offset.
const PALETTE: readonly string[] = [
  "hsl(231,48%,48%)", // indigo
  "hsl(262,52%,47%)", // violet
  "hsl(330,60%,45%)", // rose
  "hsl(349,72%,51%)", // crimson
  "hsl(14,80%,50%)", // orange-red
  "hsl(32,90%,45%)", // amber
  "hsl(158,55%,36%)", // teal-green
  "hsl(192,70%,38%)", // cyan
  "hsl(207,75%,44%)", // blue
  "hsl(280,55%,45%)", // purple
]

// djb2 hash — fast, low-collision for short strings.
function hash(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  }
  return h
}

/** Up to 2 uppercase initials from a display name.
 *  "Firstname Lastname" → "FL", "Alice" → "AL", "  " → "?", emoji/non-latin → first code point. */
export function avatarInitials(name: string): string {
  const trimmed = name?.trim() ?? ""
  if (!trimmed) return "?"

  // Split on whitespace/punctuation-like separators to get word tokens.
  const words = trimmed.split(/[\s,]+/).filter(Boolean)
  if (words.length >= 2) {
    const a = [...words[0]][0] ?? ""
    const b = [...words[words.length - 1]][0] ?? ""
    const result = (a + b).toUpperCase()
    return result || "?"
  }

  // Single word: first two characters (handles CJK + emoji via spread for code-point safety).
  const chars = [...words[0]]
  const result = chars.slice(0, 2).join("").toUpperCase()
  return result || "?"
}

/** Deterministic gradient for a seed (userId or convId).
 *  Returns a CSS `background` value: `linear-gradient(135deg, <from>, <to>)`. */
export function avatarGradient(seed: string): string {
  const h = hash(seed || "default")
  const fromIdx = h % PALETTE.length
  // Offset by 3 so the two hues are visually distinct without being adjacent.
  const toIdx = (fromIdx + 3) % PALETTE.length
  return `linear-gradient(135deg, ${PALETTE[fromIdx]}, ${PALETTE[toIdx]})`
}
