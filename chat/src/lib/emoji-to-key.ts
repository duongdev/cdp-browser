// Converts a native emoji glyph to a Teams reaction key for POST /api/teams/react.
// Named 6 defaults return their canonical key; any other glyph is encoded as hex codepoints
// joined by "_" (e.g. 💯 → "1f4af"). Teams' reactionEmoji() decoder recovers the glyph from
// the first hex segment, so the round-trip is lossless for any unicode emoji.
// Mirrors the logic in core/teams-emoji.js emojiToKey() — kept separate so the chat renderer
// never imports a CJS core module (same pattern as sanitize-message.ts / dompurify).

const NAMED: Record<string, string> = {
  "👍": "like",
  "❤️": "heart",
  "😆": "laugh",
  "😮": "surprised",
  "😢": "sad",
  "😠": "angry",
}

export function emojiToKey(emoji: string): string | null {
  if (!emoji) return null
  if (NAMED[emoji]) return NAMED[emoji]
  const cps = [...emoji].map((ch) => ch.codePointAt(0)!.toString(16)).join("_")
  if (!cps) return null
  // The Teams reactionEmoji decoder requires a "_" to recognise the codepoint-prefix format.
  // Single-codepoint glyphs get a trailing "_e" so the decoder fires; multi-codepoint already have "_".
  return cps.includes("_") ? cps : `${cps}_e`
}
