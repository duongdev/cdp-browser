// Per-device notification mute logic (t093, renderer side). Mirrors core/notif-mutes.js
// — the server (push + per-device badge) can't import this ESM module, and the renderer
// (foreground toast + bell/sidebar/home-screen badges) can't import the server's CJS, so
// the tiny logic is duplicated (the same pattern as core/notifications.js slackGroupKey ↔
// unread-aggregator.ts). `toggleMute` is renderer-only — the settings card toggles a row.
//
// A "mute key" unifies per-service (Teams/Outlook) and per-workspace (Slack) muting: Slack
// mutes by its merged-workspace groupKey ("slack:{groupId}", t092), everything else by
// adapter name. Capture stays global — these only gate *delivery* on the device whose
// ui-state holds the mute. Default is opt-out: a key absent from a device's mutes is NOT
// muted. Tested by notif-mutes.test.ts.

/** The notification fields the mute logic reads. */
export interface MuteEntry {
  adapter?: string | null
  groupKey?: string
  read?: boolean
  /** For a Slack entry, the workspace name the hijack ships (inject/slack-notify.js). Used
   *  only to label the Electron mute rows (t101) — see slackMuteRows. */
  source?: string
}

/** A muteable Slack workspace row for the Electron mute list (t101). */
export interface SlackMuteRow {
  key: string
  label: string
}

/** A collection of muted mute-keys — an array (the stored shape) or a Set. */
export type Mutes = readonly string[] | ReadonlySet<string> | undefined

// The mute key for an entry: a Slack entry's groupKey (per merged workspace), else the
// adapter name (per service). Slack with no groupKey degrades to the literal "slack".
export function muteKey(entry: MuteEntry): string {
  if (entry.adapter === "slack") return entry.groupKey || "slack"
  return entry.adapter ?? ""
}

// Coerce the stored mute collection (array | Set | undefined) to a membership test.
function has(mutes: Mutes, key: string): boolean {
  if (!mutes) return false
  if (mutes instanceof Set) return mutes.has(key)
  return (mutes as readonly string[]).includes(key)
}

// True when this device has muted the entry's source.
export function isMuted(mutes: Mutes, entry: MuteEntry): boolean {
  return has(mutes, muteKey(entry))
}

// Add an absent key / remove a present one. Returns a new array; never mutates the input.
export function toggleMute(mutes: readonly string[], key: string): string[] {
  return mutes.includes(key) ? mutes.filter((k) => k !== key) : [...mutes, key]
}

// Derive one mute row per distinct Slack workspace seen in the captured notification list —
// the source for the Electron mute UI, which has no sweep/health to enumerate workspaces
// (t101). Keyed by muteKey (slack:{teamId}); label is the workspace name the hijack entry
// carries in `source` (first non-empty wins), falling back to the key. First-seen order;
// non-Slack entries ignored; empty list → []. (Web uses the sweep's health rows instead.)
export function slackMuteRows(list: MuteEntry[]): SlackMuteRow[] {
  const order: string[] = []
  const labels = new Map<string, string>()
  for (const e of list) {
    if (e.adapter !== "slack") continue
    const key = muteKey(e)
    if (!labels.has(key)) {
      labels.set(key, "")
      order.push(key)
    }
    const src = (e.source ?? "").trim()
    if (src && !labels.get(key)) labels.set(key, src)
  }
  return order.map((key) => ({ key, label: labels.get(key) || key }))
}

// Count of unread entries whose muteKey is NOT muted on this device — the per-device badge
// number. 0 when the device master is off (a muted device shows a cleared badge).
export function unreadExcluding(list: MuteEntry[], mutes: Mutes, masterOn: boolean): number {
  if (!masterOn) return 0
  let count = 0
  for (const n of list) {
    if (n.read) continue
    if (has(mutes, muteKey(n))) continue
    count++
  }
  return count
}
