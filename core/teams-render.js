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

// Escape the HTML-significant chars in literal user text. A "Text" messagetype carries plain text,
// not HTML; once the body is assigned via innerHTML on the client, its `<`/`&` must stay literal.
function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

// Resolve Teams' two mention encodings — legacy `<at id=…>Name</at>` and the newer
// `<span itemtype="…/Mention">Name</span>` — to one stable node: `<span class="mention">@Name</span>`.
// Both carry the display name as inner text; we keep that name (any inner tags stripped, entities
// left intact) and drop every site-authored mention attribute (id/itemid/itemscope).
function resolveMentions(html) {
  return html
    .replace(/<at\b[^>]*>([\s\S]*?)<\/at>/gi, (_m, inner) => mentionSpan(inner))
    .replace(
      /<span\b[^>]*\bitemtype\s*=\s*(["'])[^"']*[Mm]ention[^"']*\1[^>]*>([\s\S]*?)<\/span>/gi,
      (_m, _q, inner) => mentionSpan(inner),
    )
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

// Render a message body to mention-resolved, entity-intact HTML (t111). Real content wins over a
// chip so a message with both text and a file keeps its words; a body-less/empty card/file falls
// back to the chip. HTML messagetypes keep their markup (mentions + emoji normalized); a literal
// "Text" messagetype is HTML-escaped (angle brackets stay literal) with newlines as <br>.
function renderBody(message) {
  const content = typeof message.content === "string" ? message.content : ""
  if (!content.trim()) return attachmentChip(message)
  const html = /html/i.test(message.messagetype || "")
    ? tagEmoji(resolveMentions(content)).trim()
    : escapeHtml(content.trim()).replace(/\r?\n/g, "<br>")
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
