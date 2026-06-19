// Pure watermark/parity reducer for the Slack content sweep (t068, ADR-0011). No I/O —
// the server (t071) injects the fetched `client.counts` + `conversations.history` results
// and the persisted watermark/excludes/muted; this module decides what to fetch and turns
// fetched messages into notification entries keyed by stable Slack message identity
// (`slack:{team}:{channel}:{ts}`). Store-level id dedup makes re-runs idempotent, so the
// watermark is an optimization (bounds history fetches), never the completeness guarantee.
//
// Parity baseline (counts-driven, ADR-0011 decision 5):
//   - DMs (ims) + group DMs (mpims): every message notifies.
//   - channels: only messages that @-mention you (direct, @here/@channel/@everyone, or a
//     user-group you're in) — conversations.history doesn't flag mentions, so we scan text.
//   - threads: treated as always-notify (a thread reply you're subscribed to).
//   - muted channels (Slack's own muted_channels pref) and the user Channel Exclude list
//     drop conversations entirely.

// Compare two Slack ts strings ("SEC.FRAC") exactly — integer part then fractional part,
// numerically, so float precision loss never reorders adjacent messages. Returns <0, 0, >0.
function tsCmp(a, b) {
  const [ai, af = ""] = String(a).split(".")
  const [bi, bf = ""] = String(b).split(".")
  const an = Number(ai)
  const bn = Number(bi)
  if (an !== bn) return an < bn ? -1 : 1
  // Pad fractional parts to equal length for a lexical-as-numeric compare.
  const len = Math.max(af.length, bf.length)
  const ap = af.padEnd(len, "0")
  const bp = bf.padEnd(len, "0")
  if (ap === bp) return 0
  return ap < bp ? -1 : 1
}

// Does a channel message @-mention the viewer? Direct (`<@U…>`), broadcast
// (`<!here|channel|everyone>`), or a subteam the viewer belongs to (`<!subteam^S…>`).
function isMention(text, selfUserId, selfSubteamIds) {
  if (!text) return false
  if (selfUserId && text.includes(`<@${selfUserId}>`)) return true
  if (/<!(here|channel|everyone)>/.test(text)) return true
  if (selfSubteamIds && selfSubteamIds.length) {
    for (const s of selfSubteamIds) {
      if (text.includes(`<!subteam^${s}`)) return true
    }
  }
  return false
}

// System message subtypes that are never user-facing notifications.
const SKIP_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "group_join",
  "group_leave",
  "retention_threshold",
  "bot_add",
  "bot_remove",
  "pinned_item",
  "reminder_add",
  "tombstone",
])

// The oldest ts to fetch from for a conversation: the watermark if ahead of last_read,
// else last_read (the first unseen message boundary).
function oldestFor(conv, watermark) {
  const wm = watermark[conv.id]
  const lr = conv.last_read || "0"
  if (wm && tsCmp(wm, lr) > 0) return wm
  return lr
}

// Decide which conversations to fetch history for. Pure over the counts + state.
// Returns [{ id, kind, oldest }]. `excludes`/`muted` are arrays of channel ids.
function planFetches(counts, { watermark = {}, excludes = [], muted = [] } = {}) {
  const ex = new Set(excludes)
  const mu = new Set(muted)
  const plans = []
  const pushIf = (conv, kind, gate) => {
    if (!conv || !conv.id) return
    if (ex.has(conv.id) || mu.has(conv.id)) return
    if (!gate) return
    plans.push({ id: conv.id, kind, oldest: oldestFor(conv, watermark) })
  }
  for (const im of counts.ims || []) pushIf(im, "im", im.has_unreads)
  for (const mp of counts.mpims || []) pushIf(mp, "mpim", mp.has_unreads)
  // Channels only when there's a mention (parity); mute already filtered above.
  for (const ch of counts.channels || []) pushIf(ch, "channel", (ch.mention_count || 0) > 0)
  return plans
}

// A candidate message is real (worth a notification) if it isn't a system subtype and
// carries an author (a human `user` or a `bot_id`).
function isRealMessage(m) {
  if (m.subtype && SKIP_SUBTYPES.has(m.subtype)) return false
  return !!(m.user || m.bot_id)
}

// Turn fetched candidate messages into new notification entries + the advanced watermark.
// `candidates` are `{ channelId, kind, ts, user?, bot_id?, subtype?, text }`. Applies
// parity (channels need a mention), mute/exclude, system-subtype + watermark filtering.
function reduceMessages({
  team,
  // The logical workspace key (`enterprise_id || teamId`, t092). The entry id + groupKey
  // derive from this so an Enterprise Grid org pseudo-team and its member workspaces (which
  // surface the same shared channels) collapse to ONE id — existing ingest id-dedup then
  // drops the duplicate. The concrete `team` is still stamped on the entry for activation /
  // SPA deep-link. Defaults to `team` for standalone workspaces (byte-unchanged behavior).
  groupId,
  candidates = [],
  watermark = {},
  excludes = [],
  muted = [],
  selfUserId = "",
  selfSubteamIds = [],
}) {
  const gid = groupId || team
  const ex = new Set(excludes)
  const mu = new Set(muted)
  const newEntries = []
  const nextWatermark = { ...watermark }
  for (const m of candidates) {
    const ch = m.channelId
    if (!ch || !m.ts) continue
    if (ex.has(ch) || mu.has(ch)) continue
    if (!isRealMessage(m)) continue
    // Drop anything already seen (at or below the per-channel watermark).
    const wm = watermark[ch]
    if (wm && tsCmp(m.ts, wm) <= 0) continue
    // Channel parity: only @-mentions. DMs/group-DMs/threads always notify.
    if (m.kind === "channel" && !isMention(m.text, selfUserId, selfSubteamIds)) continue
    newEntries.push({
      id: `slack:${gid}:${ch}:${m.ts}`,
      groupKey: `slack:${gid}`,
      team,
      channelId: ch,
      kind: m.kind,
      ts: m.ts,
      user: m.user || null,
      botId: m.bot_id || null,
      // A bot/app message carries its display name inline (no users.info lookup) — kept for
      // the renderer's sender resolution (t073).
      username: m.username || null,
      text: m.text || "",
      // The parent thread ts when this message is a thread reply (t078 reply targeting).
      threadTs: m.thread_ts || null,
      // Whether the message @-mentions the viewer (t090 highlight). Always true for the
      // channel messages that survive parity; computed literally for DMs/threads.
      mention: isMention(m.text, selfUserId, selfSubteamIds),
    })
    // Advance the per-channel watermark to the newest ts seen.
    if (!nextWatermark[ch] || tsCmp(m.ts, nextWatermark[ch]) > 0) nextWatermark[ch] = m.ts
  }
  return { newEntries, nextWatermark }
}

// Follow Slack's per-channel last_read: any stored entry at or below its channel's
// last_read flips to read (so reading on any Slack client clears our badge). Returns the
// same reference when nothing changes (cheap no-op for the common steady state).
function applyReadUpdates(entries, lastReadByChannel) {
  let changed = false
  const out = entries.map((e) => {
    const lr = lastReadByChannel[e.channelId]
    if (e.read || !lr) return e
    if (tsCmp(e.ts, lr) <= 0) {
      changed = true
      return { ...e, read: true }
    }
    return e
  })
  return changed ? out : entries
}

module.exports = { tsCmp, isMention, planFetches, reduceMessages, applyReadUpdates }
