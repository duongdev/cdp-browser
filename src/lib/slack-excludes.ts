// Pure Channel Exclude list logic (t072, ADR-0011). The list silences specific Slack
// channels/DMs for the content sweep. It's stored in server ui-state (survives the iPad
// PWA's localStorage wipe) under `slackExcludes`; the renderer edits it (Settings list +
// a "Mute this channel" action on a notification) and the server sweep reads it.
//
// An entry is keyed by `team` + `channelId` (the stable ids); `label` is display-only.

export type SlackExclude = { team: string; channelId: string; label: string }

// Add an exclude, de-duped by (team, channelId). Returns a new array; existing-same is a
// no-op (returns the same reference so callers can skip a write).
export function addExclude(list: SlackExclude[], entry: SlackExclude): SlackExclude[] {
  if (!entry.team || !entry.channelId) return list
  if (list.some((e) => e.team === entry.team && e.channelId === entry.channelId)) return list
  return [...list, { team: entry.team, channelId: entry.channelId, label: entry.label || "" }]
}

// Remove an exclude by (team, channelId). Returns the same reference when nothing matched.
export function removeExclude(
  list: SlackExclude[],
  team: string,
  channelId: string,
): SlackExclude[] {
  const next = list.filter((e) => !(e.team === team && e.channelId === channelId))
  return next.length === list.length ? list : next
}

// The excluded channel ids for one workspace — the shape the sweep reducer consumes.
export function excludedChannelIds(list: SlackExclude[], team: string): string[] {
  return list.filter((e) => e.team === team).map((e) => e.channelId)
}

// Derive a `{ team, channelId }` from a swept notification entry: team from its
// `slack:{team}` groupKey, channelId from the carried field. Returns null when the entry
// isn't a swept Slack message (no channelId / non-slack groupKey) so the UI can hide the
// action. Pure — the entry shape is the notification store's.
//
// Note: after the t092 Grid merge the groupKey is `slack:{groupId}`, so the extracted
// `team` is actually the merged groupId. Callers use it as the exclude key as-is (the
// sweep also keys excludes by groupId), so the mute matches; don't treat it as a physical
// teamId for a teamId-keyed lookup.
export function excludeTargetFromEntry(entry: {
  groupKey?: string
  channelId?: string
}): { team: string; channelId: string } | null {
  if (!entry || !entry.channelId || !entry.groupKey) return null
  const m = /^slack:(.+)$/.exec(entry.groupKey)
  if (!m) return null
  return { team: m[1], channelId: entry.channelId }
}

// Re-key persisted excludes from a member workspace's teamId to its Enterprise Grid org
// groupId (t092, ADR-0011). After the Grid merge the sweep stamps `slack:{groupId}`, so a
// new exclude keys by groupId; an exclude saved before the merge (keyed by the member's
// teamId) would stop matching. `teamGroupMap` is teamId → groupId; an entry with no map
// hit (standalone team) is untouched. Idempotent — already-groupId entries re-map to
// themselves. De-dupes when an org + member exclude of the same channel collapse to one
// key (keeps the first). Returns the same reference when nothing changed (skip a write).
export function migrateExcludes(
  list: SlackExclude[],
  teamGroupMap: Record<string, string>,
): SlackExclude[] {
  let changed = false
  const seen = new Set<string>()
  const next: SlackExclude[] = []
  for (const e of list) {
    const team = teamGroupMap[e.team] || e.team
    if (team !== e.team) changed = true
    const key = `${team}:${e.channelId}`
    if (seen.has(key)) {
      changed = true
      continue
    }
    seen.add(key)
    next.push(team === e.team ? e : { ...e, team })
  }
  return changed ? next : list
}
