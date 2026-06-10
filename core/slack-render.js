// Pure Slack message rendering for notification entries (t073, ADR-0011). Turns Slack's
// mrkdwn + entity-encoded message text into readable one-line plain text, and composes a
// "{sender} in {channel}" title. No I/O — name maps are resolved by the runner (lazy
// users.info / conversations.info, cached) and passed in. Tested by slack-render.test.ts.

// Decode the three HTML entities Slack encodes in message text.
function unescapeEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
}

// Replace Slack's `<…>` angle-token syntax (mentions, channel refs, links) with readable
// text, using the provided name maps where an id needs resolving.
function replaceTokens(text, names) {
  const users = (names && names.users) || {}
  const channels = (names && names.channels) || {}
  return text.replace(/<([^>]+)>/g, (_m, inner) => {
    // Split an optional display label: `target|label`.
    const pipe = inner.indexOf("|")
    const target = pipe === -1 ? inner : inner.slice(0, pipe)
    const label = pipe === -1 ? "" : inner.slice(pipe + 1)

    // User mention: <@U123> / <@U123|name>
    if (target[0] === "@") {
      const id = target.slice(1)
      return `@${label || users[id] || id}`
    }
    // Channel ref: <#C123> / <#C123|name>
    if (target[0] === "#") {
      const id = target.slice(1)
      return `#${label || channels[id] || id}`
    }
    // Special command: <!here>, <!channel>, <!everyone>, <!subteam^S123|@group>, <!date…>
    if (target[0] === "!") {
      const cmd = target.slice(1)
      if (cmd === "here" || cmd === "channel" || cmd === "everyone") return `@${cmd}`
      if (cmd.startsWith("subteam^")) return `@${label.replace(/^@/, "") || "team"}`
      return label || `@${cmd}`
    }
    // Link (http/https/mailto/anything): show the label, else the bare target.
    return label || target
  })
}

// Strip mrkdwn formatting markers (bold/italic/strike/inline + fenced code) to plain text.
function stripFormatting(s) {
  return s
    .replace(/```([\s\S]*?)```/g, "$1") // fenced code → contents
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/\*([^*]+)\*/g, "$1") // *bold*
    .replace(/_([^_]+)_/g, "$1") // _italic_
    .replace(/~([^~]+)~/g, "$1") // ~strike~
}

// Render a Slack message body to a single readable line. Empty / whitespace-only bodies
// (attachment- or file-only messages) get a neutral placeholder so the notification isn't blank.
function renderBody(text, names) {
  if (!text || !text.trim()) return "(attachment)"
  let out = replaceTokens(text, names)
  out = stripFormatting(out)
  out = unescapeEntities(out)
  out = out
    .replace(/\s*\n+\s*/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
  return out || "(attachment)"
}

// Compose the entry title. Channels/group-DMs/threads read "{sender} in {channel}";
// DMs read just the sender. Falls back to the workspace name when the sender is unknown.
function composeTitle({ senderName, channelName, kind, workspace }) {
  if (!senderName) return workspace || "Slack"
  if (kind === "im" || !channelName) return senderName
  const ch = kind === "channel" || kind === "thread" ? `#${channelName}` : channelName
  return `${senderName} in ${ch}`
}

module.exports = { renderBody, composeTitle, replaceTokens, stripFormatting }
