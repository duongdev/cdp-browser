// Pure Teams message rendering for the chat app (t107, ADR-0018). Mirrors core/slack-render.js:
// turns a raw Teams messages-API object into the source-agnostic ReaderMessage shape the thread
// view renders, and composes a conversation title. No I/O, no DOM — tested by teams-render.test.ts.
//
// SANITIZE STRATEGY: Teams message `content` is site-authored HTML. We reduce it to PLAIN TEXT —
// the safest possible subset — so the view renders it as a React text node and NEVER assigns
// innerHTML anywhere. Stripping every tag also drops every attribute, so event handlers
// (onerror=…) and `javascript:` urls can't survive; <script>/<style> are removed WITH their
// content so their source can't leak as visible text.

// Decode the HTML entities Teams emits. `&amp;` is decoded LAST so a double-encoded token like
// `&amp;lt;` resolves to the literal `&lt;` (one decode), not `<`.
function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => codePoint(Number.parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => codePoint(Number.parseInt(h, 16)))
    .replace(/&amp;/g, "&")
}

function codePoint(n) {
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ""
}

// HTML → plain text. Order is load-bearing: kill script/style (with content) and comments first,
// turn block boundaries into spaces so words don't glue, strip remaining tags, THEN decode
// entities (decoding before stripping would let a literal `&lt;b&gt;` be treated as a tag).
function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<\s*(br|hr|\/p|\/div|\/li|\/tr|p|div|li|tr)\b[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\s+/g, " ")
    .trim()
}

// A "Text" messagetype carries literal text (not HTML), so we decode entities + collapse
// whitespace but must NOT strip `<…>` — those are the user's own angle brackets.
function plainToText(text) {
  return decodeEntities(text).replace(/\s+/g, " ").trim()
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

// Render a message body to a single readable plain-text line. Real text wins over a chip so a
// message with both text and a file keeps its words; a body-less card/file falls back to the chip.
function renderBody(message) {
  const content = typeof message.content === "string" ? message.content : ""
  const type = message.messagetype || ""
  const text = content.trim()
    ? /html/i.test(type)
      ? htmlToText(content)
      : plainToText(content)
    : ""
  return text || attachmentChip(message)
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
    out.push({
      id: String(m.id),
      ts: toEpochMs(m.originalarrivaltime) ?? toEpochMs(m.composetime) ?? 0,
      senderId,
      senderName: m.imdisplayname || "Unknown",
      body: deleted ? "message deleted" : renderBody(m),
      self: isSelf(senderId, selfId),
      edited: !deleted && !!m.properties?.edittime,
      deleted,
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

module.exports = { renderBody, toReaderMessages, composeTitle, senderIdOf }
