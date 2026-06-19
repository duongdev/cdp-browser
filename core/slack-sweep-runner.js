// Effectful Slack sweep orchestrator (t071, ADR-0011). Composes the pure reducer
// (slack-sweep.js) with the Slack API (slack-api.js) behind injected effects, so the
// glue is unit-testable with a fake API (no network/CDP). The server wires the real
// effects (cred list, store ingest, watermark persistence) around it.
//
// Per workspace, one sweep: client.counts → plan fetches → conversations.history →
// reduce → ingest new entries → apply read updates. The first sweep SEEDS the watermark
// from current `latest` and emits nothing, so pre-existing unreads (already seen on other
// clients) don't spam — only messages arriving after we start watching notify.
//
// Deviation from ADR-0011 "no new modules": this thin DI runner is added (not inlined in
// the server) purely for testability — the reducer stays pure, the runner is the effectful
// seam. Recorded for review.

const { planFetches, reduceMessages } = require("./slack-sweep")
const { groupId } = require("./slack-creds")
const { renderBody, composeTitle, toReaderMessages } = require("./slack-render")

// Errors that mean the web API will never work for this workspace (vs. a transient/auth
// error worth retrying). The sweep gives up and lets the hijack handle these workspaces.
const PERMANENT_ERRORS = new Set(["team_is_restricted", "account_inactive", "no_permission"])

// Per-channel last_read map from a client.counts response (drives read sync).
function lastReadMap(counts) {
  const out = {}
  for (const list of [counts.channels, counts.ims, counts.mpims]) {
    for (const c of list || []) if (c.id) out[c.id] = c.last_read || "0"
  }
  return out
}

// A baseline watermark from current `latest` per conversation — used on the first sweep so
// existing unreads aren't re-notified.
function seedWatermark(counts) {
  const wm = {}
  for (const list of [counts.channels, counts.ims, counts.mpims]) {
    for (const c of list || []) if (c.id && c.latest) wm[c.id] = c.latest
  }
  return wm
}

// Parse the muted_channels pref ("C1,C2,…") into an id array.
function parseMuted(prefs) {
  const raw = prefs && prefs.ok && prefs.prefs ? prefs.prefs.muted_channels : ""
  return raw ? String(raw).split(",").filter(Boolean) : []
}

// Normalize a legacy `users.counts` response (t075) into the `client.counts`-shaped
// `{ channels, ims, mpims }` the reducer consumes, plus the muted-id list (from per-channel
// `is_muted`). users.counts has NO `last_read`/`latest`, so entries carry `last_read: "0"`
// and no `latest` — the runner seeds these workspaces to "now" instead of from `latest`.
// A channel is unread if it shows an unread or mention count; a DM if its `dm_count` > 0.
function normalizeUsersCounts(uc) {
  const muted = []
  const mapChannel = (c) => {
    if (c.is_muted) muted.push(c.id)
    const mention = c.mention_count_display ?? c.mention_count ?? 0
    const unread = c.unread_count_display ?? c.unread_count ?? 0
    return {
      id: c.id,
      mention_count: mention,
      has_unreads: unread > 0 || mention > 0,
      last_read: "0",
    }
  }
  const mapDm = (c) => ({
    id: c.id,
    mention_count: 0,
    has_unreads: (c.dm_count ?? 0) > 0,
    last_read: "0",
  })
  return {
    channels: (uc.channels || []).map(mapChannel),
    // users.counts splits private channels into `groups`; treat them like channels.
    mpims: [...(uc.groups || []).map(mapChannel), ...(uc.mpims || []).map(mapDm)],
    ims: (uc.ims || []).map(mapDm),
    muted,
  }
}

// A Slack-ts string for "now" — the restricted-path seed boundary (only messages arriving
// after we start watching notify; no history fetch needed since users.counts has no `latest`).
function nowTs(now) {
  return `${Math.floor(now / 1000)}.000000`
}

// Seed every conversation's watermark to "now" — the restricted-path baseline.
function seedToNow(counts, now) {
  const ts = nowTs(now)
  const wm = {}
  for (const list of [counts.channels, counts.ims, counts.mpims]) {
    for (const c of list || []) if (c.id) wm[c.id] = ts
  }
  return wm
}

// All conversation ids currently carrying unreads — drives the restricted path's read-sync
// (an entry whose channel is no longer unread is considered read).
function unreadChannelSet(counts) {
  const set = new Set()
  for (const list of [counts.channels, counts.ims, counts.mpims]) {
    for (const c of list || []) if (c.id && c.has_unreads) set.add(c.id)
  }
  return set
}

function createSlackSweeper(deps) {
  const log = deps.log || (() => {})

  // Fetch the workspace's unread state — client.counts, or the users.counts fallback when
  // client.counts is `team_is_restricted` (Enterprise Grid child, t075). Returns the
  // client.counts-shaped object plus `{ restricted, muted? }`, or `{ error }` to abort.
  async function fetchCounts(api) {
    const counts = await api.clientCounts()
    if (counts && !counts.error) return { counts, restricted: false }
    if (counts && counts.error === "team_is_restricted") {
      const uc = await api.usersCounts()
      if (uc && !uc.error) {
        const norm = normalizeUsersCounts(uc)
        return { counts: norm, restricted: true, muted: norm.muted }
      }
      return { error: uc && uc.error ? uc.error : "team_is_restricted", permanent: true }
    }
    return {
      error: counts ? counts.error : "no_response",
      permanent: PERMANENT_ERRORS.has(counts?.error),
    }
  }

  async function sweepWorkspace(cred) {
    const team = cred.teamId
    // The merged Enterprise Grid bucket the swept entries are keyed under (slack:{gid}, t092).
    // Anything that addresses those entries by group — read-sync (the restricted unread-set
    // path) and the Channel Exclude (mute) lookup — must key by `gid`, not the concrete
    // teamId, or it never matches an entry the org+member sweep wrote. Standalone team: gid
    // === team (byte-unchanged).
    const gid = groupId(cred)
    const api = deps.makeApi(cred)
    const { counts, restricted, muted: countsMuted, error, permanent } = await fetchCounts(api)
    if (error) {
      if (error === "invalid_auth") {
        deps.markStale(team, "invalid_auth")
        log(`[slack-sweep] ${team} creds stale (invalid_auth)`)
      } else if (permanent) {
        // Both client.counts AND users.counts are blocked — the sweep truly can't cover it,
        // so the in-page hijack falls back to storing its notifications directly (t064).
        if (deps.markUnsweepable) deps.markUnsweepable(team, error)
        log(`[slack-sweep] ${team} unsweepable (${error}) — hijack fallback`)
      }
      return
    }

    // First sweep: baseline the watermark, notify nothing, but still sync read state.
    if (!deps.isSeeded(team)) {
      // client.counts seeds from each conversation's `latest`; the restricted (users.counts)
      // path has no `latest`, so it seeds every conversation to "now" — only messages arriving
      // after watching-starts notify (no history fetch, no cold-start spam).
      const seed = restricted ? seedToNow(counts, deps.now()) : seedWatermark(counts)
      deps.setWatermark(team, seed)
      deps.markSeeded(team)
      // Read-sync: client.counts uses last_read; the restricted path uses the unread-set.
      // The unread-set path keys entries by group (slack:{gid}), so pass `gid`.
      if (restricted) deps.applyReadByUnread?.(gid, unreadChannelSet(counts))
      else deps.applyReadUpdates(team, lastReadMap(counts))
      if (deps.markSwept) deps.markSwept(team)
      log(
        `[slack-sweep] ${team} seeded (${Object.keys(seed).length} convos${restricted ? ", restricted" : ""})`,
      )
      return
    }

    // Resolve muted channels — from users.counts is_muted on the restricted path, else prefs.
    let muted = deps.getMuted(team)
    if (restricted) {
      muted = countsMuted || []
      deps.setMuted(team, muted)
    } else if (muted == null) {
      muted = parseMuted(await api.usersPrefsGet())
      deps.setMuted(team, muted)
    }
    let selfUserId = deps.getSelfUserId(team)
    if (!selfUserId) {
      const auth = await api.authTest()
      selfUserId = (auth && auth.user_id) || ""
      if (selfUserId) deps.setSelfUserId(team, selfUserId)
    }

    // Channel Exclude (mute) list is stored keyed by the merged groupId (t092), so look it
    // up by `gid` — a teamId query would miss a Grid member's groupId-keyed mute entirely.
    const excludes = deps.getExcludes(gid) || []
    const watermark = deps.getWatermark(team) || {}
    const plans = planFetches(counts, { watermark, excludes, muted })

    const candidates = []
    for (const p of plans) {
      const hist = await api.conversationsHistory(p.id, { oldest: p.oldest, limit: 50 })
      if (!hist || !hist.ok) continue
      for (const m of hist.messages || []) {
        candidates.push({
          channelId: p.id,
          kind: p.kind,
          ts: m.ts,
          user: m.user,
          bot_id: m.bot_id,
          username: m.username,
          subtype: m.subtype,
          text: m.text,
          thread_ts: m.thread_ts,
        })
      }
    }

    const { newEntries, nextWatermark } = reduceMessages({
      team,
      // Collapse an Enterprise Grid org pseudo-team + its member workspaces into one
      // logical bucket (t092) — the entry id + groupKey key by this, so a message in a
      // channel reachable from both the org and the workspace dedups via ingest's id check.
      groupId: gid,
      candidates,
      watermark,
      excludes,
      muted,
      selfUserId,
      selfSubteamIds: [],
    })
    deps.setWatermark(team, nextWatermark)
    if (newEntries.length) {
      const names = await resolveNames(api, team, newEntries)
      for (const e of newEntries) deps.ingestEntry(decorate(e, cred, names))
    }
    // Read-sync: client.counts follows per-message last_read; the restricted path has none,
    // so it marks read any entry whose channel is no longer in the unread-set. The unread-set
    // path keys entries by group (slack:{gid}), so pass `gid`.
    if (restricted) deps.applyReadByUnread?.(gid, unreadChannelSet(counts))
    else deps.applyReadUpdates(team, lastReadMap(counts))
    if (deps.markSwept) deps.markSwept(team)
    if (newEntries.length) log(`[slack-sweep] ${team}: +${newEntries.length} entries`)
  }

  // Resolve the user + channel display names referenced by a batch of entries — both the
  // senders and any `<@U…>`/`<#C…>` tokens inside the bodies — lazily via users.info /
  // conversations.info, cached per workspace through the injected accessors. Returns the
  // `{ users, channels }` name maps the renderer (t073) consumes.
  async function resolveNames(api, team, entries) {
    const users = {}
    const channels = {}
    const userIds = new Set()
    const channelIds = new Set()
    const MENTION = /<@([UW][A-Z0-9]+)/g
    const CHANNEL = /<#(C[A-Z0-9]+)/g
    for (const e of entries) {
      if (e.user) userIds.add(e.user)
      // Channel name is needed for the title of a channel/group message (not a DM).
      if (e.channelId && e.kind !== "im") channelIds.add(e.channelId)
      for (const m of (e.text || "").matchAll(MENTION)) userIds.add(m[1])
      for (const m of (e.text || "").matchAll(CHANNEL)) channelIds.add(m[1])
    }
    for (const id of userIds) {
      let name = deps.getUserName ? deps.getUserName(team, id) : undefined
      if (name === undefined) {
        const r = await api.usersInfo(id)
        name = r && r.ok && r.user ? displayName(r.user) : ""
        if (deps.setUserName) deps.setUserName(team, id, name)
      }
      if (name) users[id] = name
    }
    for (const id of channelIds) {
      let name = deps.getChannelName ? deps.getChannelName(team, id) : undefined
      if (name === undefined) {
        const r = await api.conversationsInfo(id)
        name = r && r.ok && r.channel ? r.channel.name || "" : ""
        if (deps.setChannelName) deps.setChannelName(team, id, name)
      }
      if (name) channels[id] = name
    }
    return { users, channels }
  }

  // On-demand history for the Conversation Reader (t077, ADR-0012): one conversations.history
  // page rendered through the same name-resolution caches the sweep uses. Read-only — never
  // touches the watermark or ingests entries, so a reader open can't disturb sweep state.
  // Typed errors mirror the sweep's: invalid_auth (creds marked stale) and rate_limited.
  async function fetchConversation(cred, channelId, opts) {
    const team = cred.teamId
    const api = deps.makeApi(cred)
    const hist = await api.conversationsHistory(channelId, {
      oldest: "0",
      limit: (opts && opts.limit) || 30,
    })
    if (!hist || hist.error || !hist.ok) {
      const error = hist && hist.error ? hist.error : "bad_response"
      if (error === "invalid_auth") deps.markStale(team, "invalid_auth")
      return { error }
    }
    const messages = hist.messages || []
    // Reuse the sweep's lazy name resolver — senders + in-body tokens, cached per team.
    const names = await resolveNames(
      api,
      team,
      messages.map((m) => ({ user: m.user, channelId: null, kind: "im", text: m.text })),
    )
    return { messages: toReaderMessages(messages, names, deps.getSelfUserId(team) || "") }
  }

  // Sweep every workspace with fresh creds (skips stale). The server calls this on a timer.
  async function runOnce() {
    const creds = (deps.listCreds ? deps.listCreds() : []).filter((c) => c && c.fresh !== false)
    for (const cred of creds) {
      try {
        await sweepWorkspace(cred)
      } catch (e) {
        log(`[slack-sweep] ${cred.teamId} sweep error: ${e && e.message ? e.message : e}`)
      }
    }
  }

  return { sweepWorkspace, runOnce, fetchConversation }
}

// A user's best display name: display_name (what Slack shows) → real_name → handle.
function displayName(user) {
  const p = user.profile || {}
  return p.display_name || p.real_name || user.real_name || user.name || ""
}

// Shape a reduced sweep entry into the notification store's entry contract, rendering the
// title ("{sender} in #{channel}", DM: just sender) and the body (mentions resolved, mrkdwn
// stripped) via the t073 renderer using the resolved `names` maps. Slack ts → ms epoch.
function decorate(entry, cred, names) {
  const tsMs = Math.round(Number(entry.ts) * 1000) || Date.now()
  const senderName =
    (entry.user && names.users[entry.user]) || entry.username || (entry.botId ? "Bot" : "")
  const channelName = entry.kind === "im" ? null : names.channels[entry.channelId] || null
  const title = composeTitle({ senderName, channelName, kind: entry.kind, workspace: cred.name })
  // The conversation's display name for the clean group label (t090): the channel/group
  // name, or the DM partner's name for a 1:1.
  const slackConvo = entry.kind === "im" ? senderName || null : channelName
  return {
    id: entry.id,
    adapter: "slack",
    groupKey: entry.groupKey,
    team: entry.team,
    source: cred.name || "Slack",
    title,
    body: renderBody(entry.text, names),
    targetUrl: cred.url || "",
    // Deep-link to the channel via the same spa-link intent the hijack used.
    activate: { type: "spa-link", url: `/client/${entry.team}/${entry.channelId}` },
    icon: "/icons/slack.svg",
    ts: tsMs,
    // Carried through for read-sync + rendering (t073).
    channelId: entry.channelId,
    slackTs: entry.ts, // original Slack ts (string) — read-sync compares this vs last_read
    slackThreadTs: entry.threadTs || null, // parent thread ts when a thread reply (t078)
    slackKind: entry.kind,
    slackConvo, // resolved conversation name → clean group label (t090)
    slackMention: !!entry.mention, // @-mention highlight (t090)
    slackUser: entry.user,
    slackBotId: entry.botId,
  }
}

module.exports = {
  createSlackSweeper,
  lastReadMap,
  seedWatermark,
  parseMuted,
  normalizeUsersCounts,
  seedToNow,
  unreadChannelSet,
  nowTs,
}
