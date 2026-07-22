// Pure Teams message rendering for the chat app (t107/t111, ADR-0018). Mirrors core/slack-render.js:
// turns a raw Teams messages-API object into the source-agnostic ReaderMessage shape the thread
// view renders, and composes a conversation title. No I/O, no DOM — tested by teams-render.test.ts.
//
// SANITIZE STRATEGY (t111): Teams message `content` is site-authored HTML, and we render it RICH
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
// Teams splits ONE person's @mention into per-token spans (t118) — "@Glory Nguyen - Group Office [C]"
// arrives as 6 adjacent Mention spans, and properties.mentions maps EVERY one of their itemids to the
// SAME person's mri. So a RUN of adjacent same-person spans (grouped by mri, else by itemid) collapses
// into one pill. `mentionMri` is the itemid→mri map (string keys) built by renderBody; without it each
// span keys on its own itemid, so nothing merges (we never merge two different people). Legacy `<at>`
// is one pill each — Teams never splits those.
function resolveMentions(html, mentionMri = {}) {
  const withAt = html.replace(/<at\b[^>]*>([\s\S]*?)<\/at>/gi, (_m, inner) => mentionSpan(inner))
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
  return mergeMentionRuns(withSentinels).replace(SENTINEL_RE, (_m, _key, text) => mentionSpan(text))
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

function mentionSpan(inner) {
  const name = inner
    .replace(/<[^>]+>/g, "")
    .trim()
    .replace(/^@+/, "")
  return `<span class="mention">@${name || "mention"}</span>`
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
// (e.g. `<p></p>`) falls back to the attachment chip, matching the pre-t111 behavior.
function hasVisibleText(html) {
  if (/<img\b/i.test(html)) return true
  return (
    html
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .trim().length > 0
  )
}

// A card (adaptive card, deferred to t112) or file attachment → a chip placeholder.
function attachmentChip(message) {
  const props = message.properties || {}
  if (props.cards) return "[card]"
  const atts = message.attachments
  if (Array.isArray(atts) && atts.length > 0) {
    const name = atts[0] && (atts[0].name || atts[0].contentType)
    return name ? `[attachment: ${name}]` : "[attachment]"
  }
  return ""
}

// ---- reactions (t120) -----------------------------------------------------
// Parse `properties.emotions` — `[{ key, users: [{ mri, time, value }] }]` — into flat reaction
// descriptors `{ key, emoji, count, mine, userMris }`. Like properties.mentions/files it may arrive
// as a JSON STRING (the t118 trap), so parse defensively. A key with zero reactors is dropped (Teams
// leaves an empty `users` row behind after a remove). `mine` is true when the viewer's oid is among
// the mris. `userMris` carries the reactor MRIs (capped, t121) so the server can resolve them to
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
// string keys. Drives the same-person run merge in resolveMentions (t118).
function mentionMriMap(message) {
  let list = message.properties?.mentions
  // Teams sends properties.mentions as a JSON STRING (not a parsed array) — parse it defensively so
  // the itemid→mri map is populated and the same-person run merge fires (t118 shipped assuming an
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

// ---- attachments (t119) ---------------------------------------------------
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

// Parse call-recording (URIObject type "Video…/CallRecording…") and Swift-card (type "SWIFT…")
// blocks out of `content`. Recording → its proxied AMS thumbnail; card → its <Title> + thumbnail.
function parseUriObjects(content) {
  const html = typeof content === "string" ? content : ""
  const out = []
  for (const m of html.matchAll(URIOBJECT_RE)) {
    const type = attrValue(m[1], "type")
    const thumb = proxyThumb(attrValue(m[1], "url_thumbnail"))
    if (/CallRecording/i.test(type)) {
      const att = { kind: "recording" }
      if (thumb) att.thumbnailUrl = thumb
      out.push(att)
    } else if (/SWIFT/i.test(type)) {
      const titleM = m[2].match(/<Title\b[^>]*>([\s\S]*?)<\/Title>/i)
      const title = titleM ? titleM[1].replace(/<[^>]+>/g, "").trim() : ""
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

// Render a message body to mention-resolved, entity-intact HTML (t111). Real content wins over a
// chip so a message with both text and a file keeps its words; a body-less/empty card/file falls
// back to the chip. HTML messagetypes keep their markup (mentions + emoji normalized); a literal
// "Text" messagetype is HTML-escaped (angle brackets stay literal) with newlines as <br>.
function renderBody(message) {
  // Strip <URIObject> blocks (call-recording / Swift card) FIRST, before the messagetype branch —
  // these messagetypes (RichText/Media_CallRecording, RichText/Media_Card) are NOT "html", so without
  // stripping here they hit the escape branch and leak as literal `<URIObject …>` text (t119). The
  // chip (parseAttachments) carries their meaning.
  const content = stripUriObjects(typeof message.content === "string" ? message.content : "")
  if (!content.trim()) return attachmentChip(message)
  if (!/html/i.test(message.messagetype || "")) {
    return escapeHtml(content.trim()).replace(/\r?\n/g, "<br>")
  }
  const html = rewriteMediaHtml(tagEmoji(resolveMentions(content, mentionMriMap(message))).trim())
  return hasVisibleText(html) ? html : attachmentChip(message)
}

// Teams sender identity lives in the MRI (`8:orgid:<oid>`), which `from` carries either bare or as
// the tail of a contacts URL. Return the bare MRI — the durable id for replies/avatars (t108).
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

// System / control threads that aren't conversation content (member add/remove, topic update…).
function isSystemMessage(message) {
  return /^ThreadActivity\//i.test(message.messagetype || "")
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
    if (!m?.id || isSystemMessage(m)) continue
    const deleted = isDeleted(m)
    const senderId = senderIdOf(m.from)
    const attachments = deleted ? [] : parseAttachments(m)
    const reactions = deleted ? [] : parseEmotions(m, selfId)
    out.push({
      id: String(m.id),
      ts: toEpochMs(m.originalarrivaltime) ?? toEpochMs(m.composetime) ?? 0,
      senderId,
      senderName: m.imdisplayname || "Unknown",
      body: deleted ? "message deleted" : renderBody(m),
      self: isSelf(senderId, selfId),
      edited: !deleted && !!m.properties?.edittime,
      deleted,
      ...(attachments.length ? { attachments } : {}),
      ...(reactions.length ? { reactions } : {}),
    })
  }
  out.sort((a, b) => a.ts - b.ts)
  return out
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
}
