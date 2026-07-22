// Teams reaction ("emotion") key → display emoji (t120, ADR-0018). Teams stores reactions by a
// NAMED key (`like`/`heart`/…), not a raw emoji, so the read path resolves the key to a glyph and
// the quick-react bar offers the six defaults. Pure table — tested by teams-emoji.test.ts.

// The six default Teams reactions, in Teams' bar order.
const DEFAULT_REACTIONS = [
  { key: "like", emoji: "👍" },
  { key: "heart", emoji: "❤️" },
  { key: "laugh", emoji: "😆" },
  { key: "surprised", emoji: "😮" },
  { key: "sad", emoji: "😢" },
  { key: "angry", emoji: "😠" },
]

// Defaults plus the common extended keys seen in live data. Unknown keys fall back to a neutral
// glyph (never the raw key text). ponytail: partial extended set — add rows as new keys surface.
const EMOJI = {
  ...Object.fromEntries(DEFAULT_REACTIONS.map((r) => [r.key, r.emoji])),
  loudlycrying: "😭",
  heart_eyes: "😍",
  smile: "😄",
  cry: "😢",
  laughing: "😆",
  clap: "👏",
  fire: "🔥",
  party: "🎉",
  check: "✅",
  thinking: "🤔",
  ok_hand: "👌",
  raising_hands: "🙌",
  raised_hands: "🙌",
  plus_one: "👍",
  thumbsup: "👍",
  thumbsdown: "👎",
  joy: "😂",
  rofl: "🤣",
  wink: "😉",
  cool: "😎",
  sunglasses: "😎",
  pray: "🙏",
  folded_hands: "🙏",
  tada: "🎉",
  eyes: "👀",
  wave: "👋",
  muscle: "💪",
  rocket: "🚀",
  star: "⭐",
  fire2: "🔥",
  100: "💯",
  ok: "✅",
  yes: "✅",
  man_gesturing_not_ok: "🙅",
  woman_gesturing_not_ok: "🙅‍♀️",
  angry_face: "😠",
  smiley: "😄",
}

function reactionEmoji(key) {
  return EMOJI[key] || "🙂"
}

module.exports = { reactionEmoji, DEFAULT_REACTIONS }
