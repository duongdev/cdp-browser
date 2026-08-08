// Shared wire-properties builder for every Teams SEND path (t182). Text replies, single-image
// uploads, multi-image uploads and file uploads all post to the same messages endpoint and all
// need the same `properties` payload for quotes and @mentions — but before t182 only the text
// reply path built it, so attaching a file silently dropped both. This module is the one pure
// builder they share (the effectful send lives in web/server.mjs). Tested by teams-send-props.test.ts.

const { escapeHtml } = require("./teams-ams.js")

// Build the `properties` object for a send. `quotes` are ReplyRef-shaped ({messageId, sender,
// time}); `mentions` are Teams-native ({itemid, mri, displayName}). `extra` is merged last and
// carries per-path payloads the caller already owns (the file chip's `files` JSON string).
//
// A quoted reply carries `qtdMsgs` (+ formatVariant/hasValidMsgReferences) so Teams renders it as
// a native reply, not just inline blockquote markup (PSN-92, verified against a real reply's wire).
//
// @mentions ride as a JSON-STRING `properties.mentions` (per-token, live-verified) — Teams' own
// wire keeps this as a string, not a nested array.
//
// `@type` + `mentionType` are LOAD-BEARING, not decoration: native Teams stamps both on every
// entry, and an entry missing either is stored fine (201) yet mentions nobody — Teams renders the
// raw per-token spans and never fans the message into the recipient's mention feed. Proven live
// (PSN-120, scripts/mention-spike.mjs) against `48:mentions`, the service-side oracle. Same for a
// bare-oid `mri`: it must be the full `8:orgid:{oid}` MRI. An entry without an mri is DROPPED
// rather than sent — it would notify nobody while looking like it worked.
function buildSendProperties({ quotes = [], mentions = [], extra = {} } = {}) {
  const properties = {}

  if (quotes.length) {
    properties.qtdMsgs = quotes.map((q) => ({
      messageId: q.messageId,
      sender: q.sender,
      time: q.time,
      message: null,
      validationResult: "Valid",
      sharedRefId: null,
      replyChainId: null,
    }))
    properties.formatVariant = "TEAMS"
    properties.hasValidMsgReferences = true
  }

  const usable = mentions.filter((m) => m?.mri)
  if (usable.length) {
    properties.mentions = JSON.stringify(
      usable.map((m) => ({
        "@type": "http://schema.skype.com/Mention",
        itemid: m.itemid,
        mri: m.mri,
        mentionType: "person",
        displayName: m.displayName,
      })),
    )
  }

  return { ...properties, ...extra }
}

// The caption HTML that rides above an uploaded image/file. `html` is the composer's pre-built
// rich body and is used VERBATIM when present — that is the only way mention spans survive to the
// wire, since escaping the plain text would neuter them. Falls back to escaped text (newlines →
// <br>), and to "" when there is nothing to say.
function captionHtml({ text, html } = {}) {
  if (html && String(html).trim()) return html
  if (!text || !String(text).trim()) return ""
  return escapeHtml(text).replace(/\n/g, "<br>")
}

module.exports = { buildSendProperties, captionHtml }
