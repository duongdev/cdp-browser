// Pure Teams message rendering for the chat app (t129/t133, ADR-0019). Mirrors core/slack-render.js:
// turns a raw Teams messages-API object into the source-agnostic ReaderMessage shape the thread
// view renders, and composes a conversation title. No I/O, no DOM — tested by teams-render.test.ts.
//
// SANITIZE STRATEGY (t133): Teams message `content` is site-authored HTML, and we render it RICH
// (bold/italic/links/mentions/emoji/code/lists/quotes). This module is PURE and does NOT sanitize —
// it only resolves Teams' mention/emoji encodings into stable, style-able nodes and leaves the rest
// of the HTML (and its entities) intact. The XSS boundary is the RENDERER: sanitize-message.ts runs
// DOMPurify (browser-native) over this output before any dangerouslySetInnerHTML. Entities are left
// ENCODED here — decoding them into new tags is exactly what we must not do.

const { rewriteMediaHtml, isValidAmsUrl } = require("./teams-media")
const { reactionEmoji } = require("./teams-emoji")

// Escape the HTML-significant chars in literal user text. A "Text" messagetype carries plain text,
// not HTML; once the body is assigned via innerHTML on the client, its `<`/`&` must stay literal.
function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

// Private-use-area sentinels wrapping a resolved itemtype-Mention span while a run is merged: S_OPEN
// opens, S_SPLIT divides the group key from the display text, S_CLOSE closes (U+E000-E002 — can't
// occur in Teams site HTML, and not control chars). Built from code points so no literal special
// char lives in source. Every sentinel is replaced by a pill before resolveMentions returns, so none
// ever leaks to the output.
// ponytail: if a mention's inner text ever literally held U+E000-E002 the sentinel would break —
// unreachable for Teams-authored HTML; not guarding it.
const S_OPEN = String.fromCharCode(0xe000)
const S_SPLIT = String.fromCharCode(0xe001)
const S_CLOSE = String.fromCharCode(0xe002)
const NOT_SPLIT_CLOSE = `[^${S_SPLIT}${S_CLOSE}]*`
const NOT_CLOSE = `[^${S_CLOSE}]*`
const SENTINEL_RE = new RegExp(
  `${S_OPEN}(${NOT_SPLIT_CLOSE})${S_SPLIT}(${NOT_CLOSE})${S_CLOSE}`,
  "g",
)
// Two adjacent sentinels sharing the SAME key (the `\\1` backref), separated only by whitespace/nbsp.
const RUN = new RegExp(
  `${S_OPEN}(${NOT_SPLIT_CLOSE})${S_SPLIT}(${NOT_CLOSE})${S_CLOSE}(?:\\s|&nbsp;|&#160;|&#xa0;)*${S_OPEN}\\1${S_SPLIT}(${NOT_CLOSE})${S_CLOSE}`,
  "gi",
)

// Resolve Teams' two mention encodings — legacy `<at id=…>Name</at>` and the newer
// `<span itemtype="…/Mention">Name</span>` — to one stable node: `<span class="mention">@Name</span>`.
// Both carry the display name as inner text; we keep that name (any inner tags stripped, entities
// left intact) and drop every site-authored mention attribute (id/itemid/itemscope).
//
// Teams splits ONE person's @mention into per-token spans (t140) — "@Glory Nguyen - Group Office [C]"
// arrives as 6 adjacent Mention spans, and properties.mentions maps EVERY one of their itemids to the
// SAME person's mri. So a RUN of adjacent same-person spans (grouped by mri, else by itemid) collapses
// into one pill. `mentionMri` is the itemid→mri map (string keys) built by renderBody; without it each
// span keys on its own itemid, so nothing merges (we never merge two different people). Legacy `<at>`
// is one pill each — Teams never splits those.
function resolveMentions(html, mentionMri = {}, selfId = "") {
  const withAt = html.replace(/<at\b([^>]*)>([\s\S]*?)<\/at>/gi, (_m, attrs, inner) => {
    const idm = attrs.match(/\bid\s*=\s*(?:(["'])([\s\S]*?)\1|([^\s>]+))/i)
    const mri = idm ? (idm[2] ?? idm[3]) : ""
    return mentionSpan(inner, mentionIsSelf(mri, selfId))
  })
  let uid = 0
  const withSentinels = withAt.replace(
    /<span\b([^>]*\bitemtype\s*=\s*(["'])[^"']*[Mm]ention[^"']*\2[^>]*)>([\s\S]*?)<\/span>/gi,
    (_m, attrs, _q, inner) => {
      const idm = attrs.match(/\bitemid\s*=\s*(?:(["'])([\s\S]*?)\1|([^\s>]+))/i)
      const itemid = idm ? (idm[2] ?? idm[3]) : null
      const key = mentionMri[String(itemid)] ?? (itemid != null ? `id:${itemid}` : `uniq:${uid++}`)
      const text = inner.replace(/<[^>]+>/g, "").trim()
      return `${S_OPEN}${key}${S_SPLIT}${text}${S_CLOSE}`
    },
  )
  // The sentinel key is the person's mri (when properties.mentions mapped it), so the self check
  // rides the same identity the run merge uses — a mention of the viewer gets `mention-self` (t160).
  return mergeMentionRuns(withSentinels).replace(SENTINEL_RE, (_m, key, text) =>
    mentionSpan(text, mentionIsSelf(key, selfId)),
  )
}

// Does a mention key (an mri like `8:orgid:<oid>`, possibly behind the `id:` fallback prefix) point
// at the signed-in user? Matches on the oid tail, like isSelf.
function mentionIsSelf(key, selfId) {
  if (!selfId || !key) return false
  const mri = String(key).replace(/^id:/, "")
  return mri === selfId || oidOf(mri) === oidOf(selfId)
}

// Collapse a run of same-key sentinels, joining the texts with a single space; repeat until stable so
// a 6-span run folds fully. The `\1` backref forces same-key — two different people never match (their
// sentinels aren't consumed, so they still emit as two separate pills).
function mergeMentionRuns(html) {
  let out = html
  let prev
  do {
    prev = out
    out = out.replace(RUN, (_m, key, t1, t2) => `${S_OPEN}${key}${S_SPLIT}${t1} ${t2}${S_CLOSE}`)
  } while (out !== prev)
  return out
}

function mentionSpan(inner, isSelfMention = false) {
  const name = inner
    .replace(/<[^>]+>/g, "")
    .trim()
    .replace(/^@+/, "")
  const cls = isSelfMention ? "mention mention-self" : "mention"
  return `<span class="${cls}">@${name || "mention"}</span>`
}

// Teams emoji arrive as `<img itemtype="…/Emoji" …>`. Tag them `class="emoji"` (only when the img
// has no class already) so the renderer can size them inline (~1.25em) while any other image stays
// width-bounded. `class` survives the DOMPurify allowlist; the itemtype attr is dropped there.
function tagEmoji(html) {
  return html.replace(/<img\b([^>]*)>/gi, (full, attrs) => {
    if (!/\bitemtype\s*=\s*(["'])[^"']*[Ee]moji[^"']*\1/.test(attrs)) return full
    if (/\bclass\s*=/i.test(attrs)) return full
    return `<img class="emoji"${attrs}>`
  })
}

// Does the rendered HTML carry anything visible (text or an image)? An empty/whitespace-only body
// (e.g. `<p></p>`) falls back to the attachment chip, matching the pre-t133 behavior.
function hasVisibleText(html) {
  if (/<img\b/i.test(html)) return true
  return (
    html
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .trim().length > 0
  )
}

// A card (adaptive card generic fallback, t151) or file attachment → a placeholder body. An adaptive
// card degrades to a styled generic card block (title/subtitle/text extracted best-effort, grilled
// #7 — NO adaptivecards dep); a file attachment is a bracket label the renderer shows as a chip.
function attachmentChip(message) {
  const card = cardFallback(message)
  if (card) return card
  const atts = message.attachments
  if (Array.isArray(atts) && atts.length > 0) {
    const name = atts[0] && (atts[0].name || atts[0].contentType)
    return name ? `[attachment: ${name}]` : "[attachment]"
  }
  return ""
}

// ---- adaptive-card generic fallback (t151, grilled #7) --------------------
// `properties.cards` (a JSON STRING like every other prop) carries AdaptiveCards we don't render
// natively. Extract best-effort title/subtitle/body text and emit ONE styled generic card block —
// a `<div class="teams-card">` the renderer styles + DOMPurify keeps (div is not in the allowlist,
// so it's promoted to a span-based structure the sanitizer preserves). No actions, no images.
const CARD_TEXT_CAP = 400

// Walk an AdaptiveCard body/items tree collecting TextBlock `text` strings, in order, deduped-adjacent.
function collectCardText(node, out) {
  if (!node || out.length > 12) return
  if (Array.isArray(node)) {
    for (const n of node) collectCardText(n, out)
    return
  }
  if (typeof node !== "object") return
  if (typeof node.text === "string") {
    const t = node.text.trim()
    if (t && out[out.length - 1] !== t) out.push(t)
  }
  if (typeof node.title === "string") {
    const t = node.title.trim()
    if (t && out[out.length - 1] !== t) out.push(t)
  }
  collectCardText(node.body, out)
  collectCardText(node.items, out)
  collectCardText(node.columns, out)
}

// Strip AdaptiveCard/markdown-ish inline markup (**, __, [text](url)) to plain text for the fallback.
function stripCardMarkup(s) {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]{1,3}/g, "")
    .trim()
}

function cardFallback(message) {
  let cards = message.properties?.cards
  if (typeof cards === "string") {
    try {
      cards = JSON.parse(cards)
    } catch {
      cards = null
    }
  }
  if (!Array.isArray(cards) || cards.length === 0) return ""
  const lines = []
  for (const c of cards) collectCardText(c?.content ?? c, lines)
  const texts = lines.map(stripCardMarkup).filter(Boolean)
  if (texts.length === 0)
    return `<span class="teams-card"><span class="teams-card-title">Card</span></span>`
  const [title, ...rest] = texts
  const bodyText = rest.join(" · ").slice(0, CARD_TEXT_CAP)
  const parts = [`<span class="teams-card-title">${escapeHtml(title.slice(0, 120))}</span>`]
  if (bodyText) parts.push(`<span class="teams-card-body">${escapeHtml(bodyText)}</span>`)
  return `<span class="teams-card">${parts.join("")}</span>`
}

// ---- reactions (t142) -----------------------------------------------------
// Parse `properties.emotions` — `[{ key, users: [{ mri, time, value }] }]` — into flat reaction
// descriptors `{ key, emoji, count, mine, userMris }`. Like properties.mentions/files it may arrive
// as a JSON STRING (the t140 trap), so parse defensively. A key with zero reactors is dropped (Teams
// leaves an empty `users` row behind after a remove). `mine` is true when the viewer's oid is among
// the mris. `userMris` carries the reactor MRIs (capped, t143) so the server can resolve them to
// names for the hover tooltip; `count` stays the exact reactor total.
const REACTOR_MRI_CAP = 25
function parseEmotions(message, selfId) {
  let emotions = message.properties?.emotions
  if (typeof emotions === "string") {
    try {
      emotions = JSON.parse(emotions)
    } catch {
      emotions = null
    }
  }
  if (!Array.isArray(emotions)) return []
  const out = []
  for (const e of emotions) {
    if (!e?.key) continue
    const users = Array.isArray(e.users) ? e.users : []
    if (users.length === 0) continue
    const mine = users.some((u) => u && isSelf(String(u.mri || ""), selfId))
    const userMris = users
      .map((u) => String(u?.mri || ""))
      .filter(Boolean)
      .slice(0, REACTOR_MRI_CAP)
    out.push({
      key: String(e.key),
      emoji: reactionEmoji(String(e.key)),
      count: users.length,
      mine,
      userMris,
    })
  }
  return out
}

// itemid→mri map from properties.mentions ({ itemid, mri, displayName }[]); itemids normalize to
// string keys. Drives the same-person run merge in resolveMentions (t140).
function mentionMriMap(message) {
  let list = message.properties?.mentions
  // Teams sends properties.mentions as a JSON STRING (not a parsed array) — parse it defensively so
  // the itemid→mri map is populated and the same-person run merge fires (t140 shipped assuming an
  // array; live data is a string, so the map was empty and mentions rendered per-token).
  if (typeof list === "string") {
    try {
      list = JSON.parse(list)
    } catch {
      list = null
    }
  }
  const map = {}
  if (Array.isArray(list)) {
    for (const m of list) {
      if (m && m.itemid != null && m.mri) map[String(m.itemid)] = String(m.mri)
    }
  }
  return map
}

// ---- attachments (t141) ---------------------------------------------------
// Teams delivers three attachment shapes the plain body can't render: file uploads (in a JSON-STRING
// `properties.files`), call recordings, and Swift cards (both as <URIObject> blocks inside `content`
// whose inner text renders as garbage). parseAttachments turns them into flat chip descriptors the
// client renders below the body; renderBody strips the URIObject blocks so they never leak as text.

// An AMS thumbnail loads only through the CA-proof media proxy (401s otherwise); a non-AMS/public
// thumbnail is left direct (mirrors rewriteMediaHtml). Empty stays empty.
function proxyThumb(url) {
  if (typeof url !== "string" || !url) return ""
  const decoded = url.replace(/&amp;/g, "&")
  return isValidAmsUrl(decoded) ? `/api/teams/media?url=${encodeURIComponent(decoded)}` : decoded
}

// Value of an attribute in a tag's attribute string (double/single quoted), or "".
function attrValue(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"))
  return m ? m[2] : ""
}

// Parse `properties.files` — a JSON STRING in live data (like properties.mentions), so parse it
// defensively. Best "open" url = fileInfo.shareUrl (browser-openable SharePoint link) → objectUrl →
// fileInfo.fileUrl. These are SharePoint (not AMS) — no proxy; the browser's SSO opens them.
function parseFiles(message) {
  let files = message.properties?.files
  if (typeof files === "string") {
    try {
      files = JSON.parse(files)
    } catch {
      files = null
    }
  }
  if (!Array.isArray(files)) return []
  const out = []
  for (const f of files) {
    if (!f) continue
    const info = f.fileInfo || {}
    const url = info.shareUrl || f.objectUrl || info.fileUrl || undefined
    const att = { kind: "file", name: f.fileName || f.title || "file" }
    if (f.fileType) att.type = String(f.fileType)
    if (url) att.url = String(url)
    out.push(att)
  }
  return out
}

const URIOBJECT_RE = /<URIObject\b([^>]*)>([\s\S]*?)<\/URIObject>/gi

// A finished recording's playback URL lives on SharePoint/OneDrive, not AMS (t162, live-probed):
// the `<a href>` "Play" link and the `onedriveForBusinessVideo` item both point at the SharePoint
// stream (browser SSO opens it, like a file chip). The AMS `amsVideo` uri also exists but a
// 43-min recording streamed through the buffering media proxy is a memory bomb — link out instead.
// A recording still being written (RecordingStatus ChunkFinished/Initial) has empty hrefs → no url.
function recordingPlayUrl(inner) {
  const anchor = inner.match(/<a\b[^>]*\bhref\s*=\s*(["'])([\s\S]*?)\1[^>]*>/i)
  if (anchor && /^https?:\/\//i.test(anchor[2])) return anchor[2]
  const od = inner.match(
    /<item\b[^>]*\btype\s*=\s*(["'])onedriveForBusinessVideo\1[^>]*\buri\s*=\s*(["'])([\s\S]*?)\2/i,
  )
  if (od && /^https?:\/\//i.test(od[3])) return od[3]
  return undefined
}

// A recording chunk that isn't the finished master carries no playable href — RecordingStatus is
// Initial/ChunkFinished (in-progress). The finished master is "Success" (live) / "viewable" (older
// format). Anything not explicitly in-progress is treated as ready so an unknown status still shows.
function isRecordingReady(inner) {
  const st = inner.match(/<RecordingStatus\b[^>]*\bstatus\s*=\s*(["'])([\s\S]*?)\1/i)
  if (!st) return true
  return !/^(Initial|ChunkFinished|InProgress|Recording)$/i.test(st[2].trim())
}

// Parse call-recording (URIObject type "Video…/CallRecording…") and Swift-card (type "SWIFT…")
// blocks out of `content`. Recording → { title, url (SharePoint playback), thumbnail, ready };
// card → its <Title> + thumbnail.
function parseUriObjects(content) {
  const html = typeof content === "string" ? content : ""
  const out = []
  for (const m of html.matchAll(URIOBJECT_RE)) {
    const type = attrValue(m[1], "type")
    const thumb = proxyThumb(attrValue(m[1], "url_thumbnail"))
    const titleM = m[2].match(/<Title\b[^>]*>([\s\S]*?)<\/Title>/i)
    const title = titleM ? titleM[1].replace(/<[^>]+>/g, "").trim() : ""
    if (/CallRecording/i.test(type)) {
      // A meeting emits several chunk rows (Initial/ChunkFinished…) before the finished master.
      // Only the ready one is playable — the in-progress chunks are dropped here so a thread shows
      // ONE recording chip, not four dead ones (t162).
      if (!isRecordingReady(m[2])) continue
      const att = { kind: "recording" }
      if (title) att.title = title
      if (thumb) att.thumbnailUrl = thumb
      const url = recordingPlayUrl(m[2])
      if (url) att.url = url
      out.push(att)
    } else if (/SWIFT/i.test(type)) {
      const att = { kind: "card", title: title || "Card" }
      if (thumb) att.thumbnailUrl = thumb
      out.push(att)
    }
  }
  return out
}

// Flat chip descriptors for one message: files first, then recordings/cards in content order.
function parseAttachments(message) {
  return [...parseFiles(message), ...parseUriObjects(message.content)]
}

// Drop whole <URIObject>…</URIObject> blocks — DOMPurify keeps their messy inner text ("Card -
// access it on go.skype.com/cards.unsupported") otherwise. The chip carries the meaning.
function stripUriObjects(html) {
  return html.replace(URIOBJECT_RE, "")
}

// Render a message body to mention-resolved, entity-intact HTML (t133). Real content wins over a
// chip so a message with both text and a file keeps its words; a body-less/empty card/file falls
// back to the chip. HTML messagetypes keep their markup (mentions + emoji normalized); a literal
// "Text" messagetype is HTML-escaped (angle brackets stay literal) with newlines as <br>.
function renderBody(message, selfId = "") {
  // Strip <URIObject> blocks (call-recording / Swift card) FIRST, before the messagetype branch —
  // these messagetypes (RichText/Media_CallRecording, RichText/Media_Card) are NOT "html", so without
  // stripping here they hit the escape branch and leak as literal `<URIObject …>` text (t141). The
  // chip (parseAttachments) carries their meaning.
  const content = stripUriObjects(typeof message.content === "string" ? message.content : "")
  if (!content.trim()) return attachmentChip(message)
  const type = message.messagetype || ""
  if (!/html/i.test(type)) {
    // A literal "Text" messagetype is real plain text → escape it (angle brackets stay literal).
    // Any OTHER non-html type whose content is XML-ish markup (a system/control payload we don't
    // recognize) must NOT leak as escaped raw XML — quiet "[unsupported]" chip instead (t151).
    if (/^Text$/i.test(type) || !/^\s*</.test(content)) {
      return escapeHtml(content.trim()).replace(/\r?\n/g, "<br>")
    }
    const chip = attachmentChip(message)
    return chip || `[unsupported: ${escapeHtml(type)}]`
  }
  const html = rewriteMediaHtml(
    tagEmoji(resolveMentions(content, mentionMriMap(message), selfId)).trim(),
  )
  return hasVisibleText(html) ? html : attachmentChip(message)
}

// Teams sender identity lives in the MRI (`8:orgid:<oid>`), which `from` carries either bare or as
// the tail of a contacts URL. Return the bare MRI — the durable id for replies/avatars (t130).
function senderIdOf(from) {
  if (typeof from !== "string" || !from) return ""
  const tail = from.split("/").pop() || from
  return tail.trim()
}

// oid (AAD object id) tail of an MRI, for self-matching against the signed-in user's oid.
function oidOf(id) {
  const i = id.lastIndexOf(":")
  return i === -1 ? id : id.slice(i + 1)
}

// self = the message's sender is the viewer. selfId is the signed-in oid; match it against the
// sender MRI's oid tail (and the raw value, in case a full MRI is ever passed as selfId).
function isSelf(senderId, selfId) {
  if (!selfId || !senderId) return false
  return senderId === selfId || oidOf(senderId) === oidOf(selfId)
}

// ISO-8601 (Teams `originalarrivaltime` / `composetime`) → epoch ms, or null.
function toEpochMs(iso) {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

// ---- system events (t151) -------------------------------------------------
// Meeting/group threads carry non-conversation events — ThreadActivity/* (member add/remove, rename,
// app added…) and Event/Call (call ended / meeting scheduled). t129 SKIPPED ThreadActivity entirely
// and Event/Call + Media_CallTranscript leaked as escaped-raw payload. Now they render as compact
// centered "system lines" ({ kind: "system", body }); an unknown/noise subtype returns null → still
// skipped. Pure — names come only from what the payload carries (event JSON friendlyname, the
// message's imdisplayname), degrading to a generic actor otherwise (no MRI-lookup here).

// A display name for an MRI is not resolvable in this pure module, so system lines lean on the names
// the payload already carries. The initiator's name = the message's imdisplayname (Teams stamps the
// actor's display name there for activity messages); a member's name = the event JSON friendlyname.
function actorName(message) {
  const n = typeof message.imdisplayname === "string" ? message.imdisplayname.trim() : ""
  return n || "Someone"
}

// First <tag>…</tag> inner text, entity/markup stripped, or "".
function tagText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"))
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : ""
}

// Parse the member list of a MemberJoined/MemberLeft JSON payload → display names (friendlyname).
function memberNames(content) {
  try {
    const j = JSON.parse(content)
    const members = Array.isArray(j?.members) ? j.members : []
    return members.map((m) => (m && String(m.friendlyname || "").trim()) || "someone")
  } catch {
    return []
  }
}

// Humanize a participant-list count → "N people". A count attr from Event/Call, else null.
function callCount(content) {
  const m = content.match(/\bcount\s*=\s*(["'])(\d+)\1/i)
  return m ? Number(m[2]) : null
}

// Reduce a ThreadActivity/* or Event/Call message to a short system line, or null to skip it. Kept
// per-subtype so an unknown/low-signal subtype (MeetingPolicyUpdated, PinnedItemsUpdate, favourites)
// degrades to null rather than rendering noise or raw XML.
function systemEventText(message) {
  const type = message.messagetype || ""
  const content = typeof message.content === "string" ? message.content : ""
  const actor = actorName(message)

  if (/^Event\/Call/i.test(type)) {
    // A call summary: `<ended/><partlist count=N>` = a finished call; a bare `<partlist><meetingDetails>`
    // (no <ended/>) = a scheduled/updated meeting placeholder — low signal, skip it.
    if (!/<ended\/>/i.test(content)) return null
    const n = callCount(content)
    return n ? `Call ended · ${n} ${n === 1 ? "person" : "people"}` : "Call ended"
  }

  const sub = type.replace(/^ThreadActivity\//i, "")
  switch (sub) {
    case "MemberJoined": {
      const names = memberNames(content)
      return names.length ? `${joinNames(names)} joined` : `${actor} joined`
    }
    case "MemberLeft": {
      const names = memberNames(content)
      return names.length ? `${joinNames(names)} left` : `${actor} left`
    }
    case "AddMember":
      return `${actor} added a member`
    case "DeleteMember": {
      // A self-removal (target === initiator) reads as "left"; else "removed a member".
      const target = tagText(content, "target")
      const initiator = tagText(content, "initiator")
      return target && target === initiator ? `${actor} left` : `${actor} removed a member`
    }
    case "TopicUpdate": {
      const value = tagText(content, "value")
      return value
        ? `${actor} renamed the conversation to "${value}"`
        : `${actor} renamed the conversation`
    }
    case "AddCustomApp": {
      const app = tagText(content, "targetName")
      return app ? `${actor} added the ${app} app` : `${actor} added an app`
    }
    default:
      // MeetingPolicyUpdated, PinnedItemsUpdate, UpdateFavDefault, and any unknown subtype → skip.
      return null
  }
}

// "A", "A and B", "A, B, and C", "A, B, +N" — a compact actor list for system lines.
function joinNames(names) {
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  if (names.length === 3) return `${names[0]}, ${names[1]}, and ${names[2]}`
  return `${names[0]}, ${names[1]}, +${names.length - 2}`
}

// A system event is a ThreadActivity/* or Event/Call message. Media_CallTranscript is control noise
// (a JSON pointer, no user value) — treated as a system event so it's routed to systemEventText,
// which returns null for it (skip) rather than the old escaped-raw leak.
function isSystemMessage(message) {
  const t = message.messagetype || ""
  return (
    /^ThreadActivity\//i.test(t) ||
    /^Event\/Call/i.test(t) ||
    /^RichText\/Media_CallTranscript/i.test(t)
  )
}

// Deleted messages arrive as a tombstone: `properties.deletetime` (or `systemdelete`) set,
// content usually blank. Body reads "message deleted" rather than the empty content.
function isDeleted(message) {
  const props = message.properties || {}
  return !!(props.deletetime || props.systemdelete)
}

// Shape a raw messages-API page into the ReaderMessage[] the thread view renders, oldest-first
// (Teams returns newest-first). Pure. selfId is the viewer's oid (accounts.user_id).
function toReaderMessages(list, selfId) {
  const out = []
  for (const m of list || []) {
    if (!m?.id) continue
    if (isSystemMessage(m)) {
      // A recognized system event → a compact system line; an unknown/noise subtype (null) is skipped.
      const text = systemEventText(m)
      if (!text) continue
      out.push({
        id: String(m.id),
        ts: toEpochMs(m.originalarrivaltime) ?? toEpochMs(m.composetime) ?? 0,
        kind: "system",
        body: text,
      })
      continue
    }
    const deleted = isDeleted(m)
    const senderId = senderIdOf(m.from)
    const attachments = deleted ? [] : parseAttachments(m)
    const reactions = deleted ? [] : parseEmotions(m, selfId)
    const body = deleted ? "message deleted" : renderBody(m, selfId)
    // A recording chunk row that produced no chip (an in-progress chunk, dropped by parseUriObjects)
    // carries no meaning — skip it so the thread shows one finished recording, not empty rows (t162).
    if (!deleted && /Media_CallRecording/i.test(m.messagetype || "") && attachments.length === 0) {
      continue
    }
    out.push({
      id: String(m.id),
      ts: toEpochMs(m.originalarrivaltime) ?? toEpochMs(m.composetime) ?? 0,
      senderId,
      // Empty when Teams omits it (e.g. recorder-authored Media_CallRecording rows) — the client
      // hides the sender header rather than printing a fabricated "Unknown" (t151).
      senderName: m.imdisplayname || "",
      body,
      self: isSelf(senderId, selfId),
      edited: !deleted && !!m.properties?.edittime,
      deleted,
      // The viewer is @mentioned (t160) — drives the row highlight without re-parsing the HTML.
      ...(body.includes("mention-self") ? { mentionsMe: true } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(reactions.length ? { reactions } : {}),
    })
  }
  out.sort((a, b) => a.ts - b.ts)
  return out
}

// ---- conversation-list preview (t151) -------------------------------------
// The list stores the RAW last-message content, so a quoted reply leaked blockquote markup, a system
// event leaked XML, and a card leaked its URIObject. previewText reduces any last-message content to
// ONE clean plain-text line: a reply keeps only the replier's own words (the quote is dropped), a
// system/control payload becomes its system line (or a generic label), a card becomes its title, and
// everything else is tag-stripped. Mirrored in chat/src/lib/conversation-view.ts (the CJS core can't
// be imported into the typechecked chat bundle). Pure; empty content → "".
function previewText(rawContent) {
  const content = typeof rawContent === "string" ? rawContent : ""
  if (!content.trim()) return ""

  // System/control XML payloads (no messagetype available here — detect by shape).
  if (/^\s*<ended\/>/i.test(content)) return "Call ended"
  if (/^\s*<partlist\b/i.test(content) || /<meetingDetails\b/i.test(content)) return "Meeting"
  if (/^\s*<topicupdate\b/i.test(content)) {
    const v = tagText(content, "value")
    return v ? `Renamed to "${v}"` : "Renamed the conversation"
  }
  if (/^\s*<(add|delete)member\b/i.test(content)) return "Membership changed"
  if (/^\s*<AddCustomApp\b/i.test(content)) {
    const app = tagText(content, "targetName")
    return app ? `Added the ${app} app` : "Added an app"
  }
  if (/^\s*<meetingpolicyupdated\b|^\s*<UpdateFavDefault\b/i.test(content)) return ""
  // A call transcript / recording pointer (Media_CallTranscript JSON) — a control artifact, no value.
  if (/scopeId\\?"\s*:|"callId\\?"\s*:/.test(content) && /^\s*[{\\]/.test(content)) return ""
  // MemberJoined/Left/PinnedItemsUpdate JSON payloads.
  if (/^\s*\{[\s\S]*"eventtime"/.test(content)) {
    const names = memberNames(content)
    return names.length ? `${joinNames(names)} joined the meeting` : ""
  }
  // A card (URIObject SWIFT / recording): its title, else a label.
  if (/<URIObject\b/i.test(content)) {
    const title = tagText(content, "Title")
    if (/CallRecording/i.test(content)) return "Call recording"
    return title || "Card"
  }

  // A quoted reply: drop the blockquote entirely, keep the replier's own words. If nothing remains
  // (a reply with no added text), fall back to the quoted preview prefixed with the reply glyph.
  // Inline images become a 📷 token FIRST (emoji imgs keep their alt char). The `(?:>|$)` also
  // catches a tag the store's PREVIEW_CAP truncated mid-attribute — plainText's `<[^>]+>` can't
  // strip an unterminated tag, which is exactly how `<img it…` leaked into the list (t151).
  let s = content
    .replace(
      /<img\b[^>]*\bitemtype\s*=\s*(["'])[^"']*Emoji[^"']*\1[^>]*(?:>|$)/gi,
      (m) => (m.match(/\balt\s*=\s*(["'])([^"']*)\1/i) || [])[2] || "",
    )
    .replace(/<img\b[^>]*(?:>|$)/gi, " 📷 ")
  const quotePreview = quotedReplyPreview(s)
  s = s.replace(
    /<blockquote\b[^>]*itemtype\s*=\s*(["'])[^"']*Reply[^"']*\1[\s\S]*?<\/blockquote>/gi,
    " ",
  )
  const own = plainText(s)
  if (own) return own
  return quotePreview ? `↩ ${quotePreview}` : ""
}

// The <p itemprop="preview"> text inside a Reply blockquote, tag-stripped, or "".
function quotedReplyPreview(html) {
  const m = html.match(
    /<blockquote\b[^>]*itemtype\s*=\s*(["'])[^"']*Reply[^"']*\1[\s\S]*?<p\b[^>]*itemprop\s*=\s*(["'])preview\2[^>]*>([\s\S]*?)<\/p>/i,
  )
  return m ? plainText(m[3]) : ""
}

// Tag-strip + entity-decode-lite + whitespace-collapse to a single plain line. Also drops a trailing
// UNTERMINATED tag (the store caps raw content at 500 chars, which can cut a tag mid-attribute).
function plainText(html) {
  return html
    .replace(/<[^>]*$/, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim()
}

// Conversation title: the topic if set, else a kind fallback (mirrors slack-render composeTitle).
function composeTitle(conv) {
  const topic = conv && typeof conv.topic === "string" ? conv.topic.trim() : ""
  if (topic) return topic
  return conv && conv.kind === "oneOnOne" ? "Direct message" : "Group chat"
}

module.exports = {
  renderBody,
  toReaderMessages,
  composeTitle,
  senderIdOf,
  parseAttachments,
  parseEmotions,
  systemEventText,
  previewText,
}
