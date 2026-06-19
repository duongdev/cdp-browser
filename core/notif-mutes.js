// Pure per-device notification mute logic (t093). Shared by web/server.mjs (push +
// per-device badge gate) and mirrored in src/lib/notif-mutes.ts for the renderer
// (foreground toast + bell/sidebar badges). Same duplication pattern as
// core/notifications.js slackGroupKey ↔ src/lib/unread-aggregator.ts — the renderer
// can't import this CJS module and the server can't import the renderer's ESM.
//
// A "mute key" unifies per-service (Teams/Outlook) and per-workspace (Slack) muting:
// Slack mutes by its merged-workspace groupKey ("slack:{groupId}", t092), everything
// else mutes by adapter name. Capture stays global — these only gate *delivery* on the
// device whose ui-state holds the mute. Default is opt-out: a key absent from a device's
// mutes is NOT muted (the device still gets that source). Tested by notif-mutes.test.ts.

// The mute key for an entry: a Slack entry's groupKey (per merged workspace), else the
// adapter name (per service). Slack with no groupKey degrades to the literal "slack".
function muteKey(entry) {
  if (entry.adapter === "slack") return entry.groupKey || "slack"
  return entry.adapter
}

// Coerce the stored mute collection (array | Set | undefined) to a membership test.
function has(mutes, key) {
  if (!mutes) return false
  if (mutes instanceof Set) return mutes.has(key)
  return mutes.includes(key)
}

// True when this device has muted the entry's source.
function isMuted(mutes, entry) {
  return has(mutes, muteKey(entry))
}

// Count of unread entries whose muteKey is NOT muted on this device — the per-device
// badge number. 0 when the device master is off (a muted device shows a cleared badge).
function unreadExcluding(list, mutes, masterOn) {
  if (!masterOn) return 0
  let count = 0
  for (const n of list) {
    if (n.read) continue
    if (has(mutes, muteKey(n))) continue
    count++
  }
  return count
}

module.exports = { muteKey, isMuted, unreadExcluding }
