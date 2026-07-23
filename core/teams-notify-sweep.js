// Pure Teams push-notification planner (t147). Mirrors the Slack sweep's first-sweep seeding
// (no cold-start spam): the server polls the conversation list on an interval and this decides
// which conversations have a NEW incoming message worth a push. Every notification is fully
// isolated from the CDP-browser notification store — this feeds the Teams-only push send path.
//
// Scope = every new incoming chat message. Skips: self-authored, system/control threads,
// non-chat messagetypes, and reserved conversations. The watermark advances for every newer
// message (even skipped ones) so a self/system message is never re-evaluated on the next poll.
const { oidFromMri } = require("./teams-names")
const { isReservedConversation } = require("./teams-store")

const PREVIEW_CAP = 140

// ponytail: naive regex HTML→text, mirrored from chat/src/lib/html-to-plain.ts (kept in sync by
// hand, not imported across the ts/cjs boundary). A push body is one line, so all whitespace —
// including the breaks <br>/</p>/</li> imply — collapses to single spaces. Swap for a real parser
// only if a faithful extraction is ever needed here.
function plainText(html) {
  if (!html) return ""
  const text = String(html)
    .replace(/<\s*br\s*\/?>/gi, " ")
    .replace(/<\/\s*(p|div|li)\s*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&") // decode last so &amp;lt; → &lt;, not <
    .replace(/\s+/g, " ")
    .trim()
  return text.length > PREVIEW_CAP ? `${text.slice(0, PREVIEW_CAP)}…` : text
}

// The sender oid from a `from` MRI — bare (`8:orgid:<oid>`) or the tail of a contacts URL.
function senderOid(from) {
  if (typeof from !== "string" || !from) return ""
  const tail = from.split("/").pop() || from
  return oidFromMri(tail.trim())
}

// True when the message's sender is the signed-in user. selfId is the account oid (cred.userId);
// compare on the normalized oid so a bare-oid `from` and an `8:orgid:` selfId still match.
function isSelfSender(from, selfId) {
  const s = senderOid(from)
  const self = oidFromMri(typeof selfId === "string" ? selfId : "")
  return !!s && !!self && s === self
}

// Whether the message content @mentions the signed-in user (t167). A mention tag carries the
// target's MRI/oid (`<span itemid="8:orgid:{oid}" itemtype="…/Mention">` or legacy `<at id=…>`),
// and a bare directory oid appears in chat content essentially only inside those tags — so a
// substring check on the normalized self oid is the whole test.
// ponytail: substring heuristic, not a mention-span parse; upgrade to teams-render's resolveMentions
// if a false positive ever shows up in practice.
function mentionsSelf(content, selfId) {
  const self = oidFromMri(typeof selfId === "string" ? selfId : "")
  if (!self || typeof content !== "string" || !content) return false
  return content.toLowerCase().includes(self.toLowerCase())
}

// Only plain-text and rich-HTML messages are real chat content. Media cards, call events, and
// ThreadActivity/* control messages are not a chat someone typed — no push.
function isRealChatMessage(messagetype) {
  const t = typeof messagetype === "string" ? messagetype.trim() : ""
  return /^text$/i.test(t) || /^richtext\/html$/i.test(t)
}

// { conversations, state, selfId } → { notifications, state }.
//   conversations: [{ id, lastMessage: { id, from, imdisplayname, content, ts, messagetype } }]
//     (caller normalizes ts to epoch ms from originalarrivaltime||composetime).
//   state: { watermarks: { [convId]: lastNotifiedTs }, seeded }.
// First (unseeded) run baselines every watermark and emits nothing. Afterwards a conversation
// whose lastMessage is newer than its watermark AND is a real incoming chat message emits one
// notification; the watermark always advances to the newest ts so nothing re-emits. When nothing
// changed the SAME state reference is returned, so the caller can skip persisting.
function planTeamsNotifications({ conversations, state, selfId } = {}) {
  const convs = Array.isArray(conversations) ? conversations : []
  const prevWatermarks = (state && state.watermarks) || {}
  const isSeeded = !!(state && state.seeded)

  if (!isSeeded) {
    const watermarks = { ...prevWatermarks }
    for (const c of convs) {
      const ts = c?.lastMessage?.ts
      if (c?.id && Number.isFinite(ts)) watermarks[c.id] = ts
    }
    return { notifications: [], state: { watermarks, seeded: true } }
  }

  let changed = false
  const watermarks = { ...prevWatermarks }
  const notifications = []
  for (const c of convs) {
    const id = c?.id
    const last = c?.lastMessage
    const ts = last?.ts
    if (!id || !Number.isFinite(ts) || isReservedConversation(id)) continue
    if (ts <= (watermarks[id] ?? 0)) continue
    // Advance for every newer message, including a self/system one we won't push, so it is never
    // re-evaluated next poll.
    watermarks[id] = ts
    changed = true
    if (isSelfSender(last.from, selfId) || !isRealChatMessage(last.messagetype)) continue
    notifications.push({
      convId: id,
      msgId: last.id,
      ts,
      senderName: last.imdisplayname || "",
      preview: plainText(last.content),
      // @me flag (t167): lets the send path push through a mute when notify-on-mention is set.
      mentionsMe: mentionsSelf(last.content, selfId),
    })
  }

  if (!changed) return { notifications: [], state }
  return { notifications, state: { watermarks, seeded: true } }
}

module.exports = { planTeamsNotifications, plainText, mentionsSelf }
