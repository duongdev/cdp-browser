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

/** The "real name" a display label carries, for initials (PSN-99). Teams labels are noisy:
 *  "Forbes Elyser - Group Office [C]" (DM), "[TG] GenAI knowledge sharing session" (group),
 *  "Dustin Do - Group Office [C] (You)" (self). Strip the `[tag]`/`(you)` noise and keep only the
 *  part before the first " - " (person, not their org), so initials come from the human name. */
export function realName(name: string): string {
  let s = (name ?? "").replace(/\[[^\]]*\]/g, " ").replace(/\([^)]*\)/g, " ")
  const dash = s.indexOf(" - ")
  if (dash > 0) s = s.slice(0, dash)
  s = s.trim().replace(/\s+/g, " ")
  // If stripping left nothing (e.g. the name was only a tag), fall back to the cleaned full string.
  return s || (name ?? "").replace(/\s+/g, " ").trim()
}

/** Up to 2 uppercase initials from the human name behind a noisy Teams label.
 *  "Forbes Elyser - Group Office [C]" → "FE", "[TG] GenAI …" → "GK", "Alice" → "AL", "" → "?". */
export function avatarInitials(name: string): string {
  const clean = realName(name)
  if (!clean) return "?"

  // First letter of the first TWO words (not first+last — "Trainer Lego …" → "TL", not "T<last>").
  const words = clean.split(/[\s,]+/).filter(Boolean)
  if (words.length >= 2) {
    const a = [...words[0]][0] ?? ""
    const b = [...words[1]][0] ?? ""
    return (a + b).toUpperCase() || "?"
  }
  // Single word: first two code points (CJK + emoji safe via spread).
  return [...words[0]].slice(0, 2).join("").toUpperCase() || "?"
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
