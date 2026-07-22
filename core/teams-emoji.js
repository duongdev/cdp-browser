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
  yes: "👍", // Teams' skin-tone thumbs-up reaction is keyed `yes` / `yes-tone1..5` — it's 👍, not ✅
  man_gesturing_not_ok: "🙅",
  woman_gesturing_not_ok: "🙅‍♀️",
  angry_face: "😠",
  smiley: "😄",
  praying: "🙏",
  heartorange: "🧡",
  giggle: "🤭",
  clappinghands: "👏",
  meltingface: "🫠",
  smilingfacewithtear: "🥲",
  sweatgrinning: "😅",
  likeWithFaceMSER: "👍",
  apple: "🍎",
  support: "🤝",
}

// Resolve a Teams emotion key to a glyph. Beyond the exact table, Teams keys carry structure we can
// decode so skin-toned / unicode reactions don't fall to the neutral glyph:
//   • `name;0-jhb-…objectId` → a custom org emoji: try the bare name.
//   • `yes-tone1` / `praying_tone3` → a skin-tone modifier: map the tone-less base (the tone is dropped;
//     Teams itself shows the base glyph in the reaction pill). This is what made 👍 render as 🙂.
//   • `1f4af_hundredpointssymbol` / `1f440_eyes` / `2705_whiteheavycheckmark` → the hex prefix IS the
//     unicode code point → derive the glyph directly (covers the whole extended-emoji class for free).
function reactionEmoji(key) {
  if (!key || typeof key !== "string") return "🙂"
  if (EMOJI[key]) return EMOJI[key]
  const bare = key.split(";")[0] // strip a custom-emoji object-id suffix
  if (bare !== key && EMOJI[bare]) return EMOJI[bare]
  const detoned = bare.replace(/[-_]tone[1-5]$/i, "")
  if (detoned !== bare && EMOJI[detoned]) return EMOJI[detoned]
  const cp = bare.match(/^([0-9a-f]{4,6})_/i)
  if (cp) {
    try {
      const g = String.fromCodePoint(Number.parseInt(cp[1], 16))
      if (g) return g
    } catch {
      // not a valid code point — fall through
    }
  }
  return "🙂"
}

module.exports = { reactionEmoji, DEFAULT_REACTIONS }
