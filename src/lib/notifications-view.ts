// Presentation grouping for the notification popover. Pure — no rendering.

import { type ActivateIntent, deriveLegacyActivate } from "./notification-activation"

export interface ViewEntry {
  id: string
  // Matched Notification Adapter name (e.g. "teams", "outlook"), stamped by the
  // shared notification center.
  adapter?: string | null
  source: string
  title: string
  body: string
  targetId: string
  targetUrl?: string
  // Stable grouping id stamped by the center (default = the targetUrl origin). The
  // popover groups by this key; a Slack adapter can emit "slack:{teamId}" to split
  // workspaces without any consumer change.
  groupKey?: string
  targetEntity?: unknown
  // Normalized deep-open intent emitted by the capture script (semantic ids only —
  // no DOM selectors). Absent → clicking only activates the owning Tab.
  activate?: ActivateIntent | null
  icon?: string | null
  ts: number
  read: boolean
  // Slack content-sweep entries carry the source channel id (t071) — used by the
  // "Mute this channel" exclude action (t072). Absent on hijack/Teams/Outlook entries.
  channelId?: string
  // Slack message identity carried by swept entries (t078): conversation kind, the
  // message's own ts, and its parent thread ts when it's a thread reply. The reply
  // target selector (slack-reply.ts) reads these; absent on non-swept entries.
  slackKind?: string
  slackTs?: string
  slackThreadTs?: string | null
  // Resolved conversation name (channel name, DM partner, or raw mpdm group name) and the
  // mention flag, stamped by the sweep (t090). Drive the clean group label + mention
  // highlight; absent on hijack entries (the label falls back to parsing the title).
  slackConvo?: string
  slackMention?: boolean
}

export interface ConversationGroup<E extends ViewEntry = ViewEntry> {
  key: string
  label: string
  icon?: string | null
  // Newest-first, capped to GROUP_ITEM_CAP. `total`/`unread` count the whole thread.
  items: E[]
  total: number
  unread: number
}

// Show only the latest few messages per thread; older ones collapse into a count.
export const GROUP_ITEM_CAP = 3

// The popover groups by *conversation thread*, not by app/origin: a Teams chat and a
// Teams channel are distinct threads even though they share an origin. (Sidebar badges
// still aggregate per-app via `groupKey` — see `unread-aggregator.ts`; the two grouping
// concerns are deliberately separate.) The thread is scoped by `groupKey` so two
// workspaces can never merge a coincidentally-equal thread id. The legacy `targetEntity`
// shape is normalized through the same `deriveLegacyActivate` the click path uses, so a
// pre-`activate` backlog message keys identically to a fresh one of the same conversation
// (grouping and mark-thread-read stay in agreement). Resolution: a Teams `thread` id (one
// key per conversation, shared by all its messages), else an Outlook `spa-link` (its
// per-message deep-link, so unrelated same-subject mail never collapses — and opening one
// never marks another read), else the entity id / title / source. Input is newest-first,
// so the first entry seen for a key is its latest message — groups stay ordered by
// most-recent message and items within stay newest-first.
export function threadKey(e: ViewEntry): string {
  const scope = e.groupKey || ""
  const activate = e.activate ?? deriveLegacyActivate(e.targetEntity)
  let thread: string
  if (activate?.type === "thread") {
    thread = `t:${activate.id}`
  } else if (activate?.type === "spa-link") {
    thread = `l:${activate.url}`
  } else {
    const entity = e.targetEntity as { id?: string } | null | undefined
    thread = (entity && typeof entity.id === "string" && entity.id) || e.title || e.source || ""
  }
  return scope ? `${scope}::${thread}` : thread
}

// Compact age label for a notification row ("now", "5m", "3h", "2d"). Pure — the
// caller supplies `now` (Date.now() at render). Shared by the bell popover and the
// phone Inbox (t076).
export function relativeTime(ts: number, now: number): string {
  const s = Math.round((now - ts) / 1000)
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

// Adapter → icon, resolved at render time (t088/t089). The stored `icon` is baked at
// capture time and for older entries points at a dead/wrong favicon URL (Slack's was a
// broken slack-edge path), so it silently fails to load. We resolve from the adapter
// instead: the real brand favicon via a stable favicon service (primary), with a bundled
// same-origin letter tile as the graceful fallback if the service is unreachable. Unknown
// adapters fall back to the stored icon.
const ADAPTER_ICON_DOMAIN: Record<string, string> = {
  teams: "teams.microsoft.com",
  outlook: "outlook.com",
  slack: "slack.com",
}

const ADAPTER_ICON_FALLBACK: Record<string, string> = {
  teams: "/icons/teams.svg",
  outlook: "/icons/outlook.svg",
  slack: "/icons/slack.svg",
}

export function iconForEntry(e: ViewEntry): string | null | undefined {
  const domain = ADAPTER_ICON_DOMAIN[e.adapter ?? ""]
  return domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64` : e.icon
}

// The same-origin tile shown if the favicon service fails to load (the `<img>` onError swap).
export function iconFallbackForEntry(e: ViewEntry): string | undefined {
  return ADAPTER_ICON_FALLBACK[e.adapter ?? ""]
}

// Pretty group-DM name from Slack's raw `mpdm-a--b--c-1` channel name → "a, b, c".
function prettyGroupDm(raw: string): string {
  const inner = raw.replace(/^mpdm-/, "").replace(/-\d+$/, "")
  return inner.split("--").filter(Boolean).join(", ")
}

// Clean Slack conversation label for a group header (t090): `#channel` for channels and
// threads, `@person` for a DM, `@a, b, c` for a group DM — never the "New message in/from"
// prefix Slack puts on its own notification title. Returns null for non-Slack entries.
// Swept entries carry structure (`slackKind` + `slackConvo`); older hijack entries only
// have Slack's title string, so we parse that as a fallback.
export function slackGroupLabel(e: ViewEntry): string | null {
  if (e.adapter !== "slack") return null
  const convo = e.slackConvo
  if (e.slackKind && convo) {
    if (e.slackKind === "im") return `@${convo}`
    if (e.slackKind === "mpim") return `@${prettyGroupDm(convo)}`
    return `#${convo}` // channel | thread
  }
  // Hijack fallback: parse Slack's own notification title.
  const title = e.title || ""
  const inCh = title.match(/^New message in (.+)$/i)
  if (inCh) return `#${inCh[1].replace(/^#/, "")}`
  const fromIn = title.match(/^New message from .+ in (.+)$/i)
  if (fromIn) return `#${fromIn[1].replace(/^#/, "")}`
  const fromDm = title.match(/^New message from (.+)$/i)
  if (fromDm) return `@${fromDm[1].replace(/^@/, "")}`
  return title || e.source || "Slack"
}

// Is this entry directed at the viewer — worth highlighting (t090/t091)? "Directed at you"
// covers both an @-mention in a channel/thread AND any DM or group DM (a DM is inherently
// to you, and Slack DM bodies often @-name you directly). Swept entries: the authoritative
// `slackMention` flag, or a DM/group-DM kind. Hijack entries (no structure): parse Slack's
// own title — a channel notification defaults to a mention, "New message from X" is a DM.
export function slackIsMention(e: ViewEntry): boolean {
  if (e.adapter !== "slack") return false
  // A DM / group DM is always direct.
  if (e.slackKind === "im" || e.slackKind === "mpim") return true
  if (typeof e.slackMention === "boolean") return e.slackMention
  const title = e.title || ""
  // Hijack fallbacks: channel notification (mention by default), mention-in-channel, or DM.
  return (
    /^New message in /i.test(title) ||
    /^New message from .+ in /i.test(title) ||
    /^New message from /i.test(title)
  )
}

// Where a Slack conversation lives (t082): the workspace name plus the conversation
// kind, for the Inbox / bell group headers. Multi-workspace users need this to tell two
// same-named channels or DMs apart — the title alone ("{sender} in #{channel}") doesn't
// carry the workspace. Null for non-Slack groups (they self-identify via icon + source)
// and for empty groups. Kind comes from the group's newest entry; a conversation never
// changes kind.
export interface SlackGroupMeta {
  workspace: string
  kind: "dm" | "group-dm" | "channel"
}

export function slackGroupMeta(items: ViewEntry[]): SlackGroupMeta | null {
  const first = items[0]
  if (!first || first.adapter !== "slack" || !first.source) return null
  const kind = first.slackKind === "im" ? "dm" : first.slackKind === "mpim" ? "group-dm" : "channel"
  return { workspace: first.source, kind }
}

// Flatten the grouped popover back into one paint-ordered row list — group order
// outer, the (capped) `items` within each group inner. Mirrors exactly what the bell
// paints (collapsed/earlier messages are excluded), so roving keyboard selection indexes
// the same rows the user sees. Pure.
export function flattenRows<E extends ViewEntry>(groups: ConversationGroup<E>[]): E[] {
  return groups.flatMap((g) => g.items)
}

export function groupByConversation<E extends ViewEntry>(list: E[]): ConversationGroup<E>[] {
  const groups: ConversationGroup<E>[] = []
  const byKey = new Map<string, ConversationGroup<E>>()
  for (const e of list) {
    const key = threadKey(e)
    let g = byKey.get(key)
    if (!g) {
      g = { key, label: e.title || e.source, icon: iconForEntry(e), items: [], total: 0, unread: 0 }
      byKey.set(key, g)
      groups.push(g)
    }
    g.total += 1
    if (g.items.length < GROUP_ITEM_CAP) g.items.push(e)
    if (!e.read) g.unread += 1
  }
  return groups
}
