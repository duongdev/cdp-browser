// Pure message URL builders (PSN-105 E). Used by the "Copy link" / "Copy Teams link" menu items.

/** App-internal message deep link: opens /chat/c/{convId} and jumps to {msgId}.
 *  The `?msg=` param is already consumed by chat-app.tsx (t175 cold deep-link handler).
 * @param origin - pass `window.location.origin` in the browser, or a string for tests. */
export function buildChatMessageUrl(convId: string, msgId: string, origin: string): string {
  return `${origin}/chat/c/${convId}?msg=${msgId}`
}

/** Teams native deep link to a chat message.
 *
 * Verified live (PSN-105 H) against a signed-in Teams v2 client: driving Teams' own
 * ⋯ → "Copy link" produced exactly
 *   https://teams.microsoft.com/l/message/{convId}/{msgId}?context=%7B%22contextType%22%3A%22chat%22%7D
 * and Teams' link builder in its bundle is
 *   `${base}/l/message/${convId}/${msgId}?context=${encodeURIComponent(ctx)}`.
 *
 * The `context` param is load-bearing, not decoration: Teams routes `/l/message` by a
 * filter that only hands the link to the chat app when `context.contextType === "chat"`.
 * A link without it falls through to the channel handler and lands on the wrong place —
 * live-checked, the old `?tenantId=&groupId=&teamName=&channelName=&createdTime=` guess
 * opened Teams on some other conversation instead of the target message.
 *
 * Channel messages use a different shape (`tenantId`/`groupId`/`teamName`/`channelName`/
 * `createdTime`) which we cannot populate; this surface only lists chats.
 */
export function buildTeamsMessageUrl(convId: string, msgId: string): string {
  const context = encodeURIComponent('{"contextType":"chat"}')
  return `https://teams.microsoft.com/l/message/${convId}/${msgId}?context=${context}`
}

/** A message link resolved to the conversation + message it points at. */
export interface MessageUrlTarget {
  convId: string
  msgId: string
}

// Teams' own deep-link hosts. Matched as a full host (or a subdomain), never a suffix — an
// `endsWith` check would happily accept `evilteams.microsoft.com.attacker.test`.
const TEAMS_HOSTS = ["teams.microsoft.com", "teams.microsoft.us", "teams.live.com"]

function isTeamsHost(host: string): boolean {
  return TEAMS_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
}

/**
 * Resolve a message link to the conversation + message it targets (t183), so a pasted Teams link
 * can open inside CDP Chats instead of bouncing the user out to the Teams web client.
 *
 * Accepts two shapes:
 *   - Teams native:  https://teams.microsoft.com/l/message/{convId}/{msgId}?context=…
 *   - This app:      {origin}/chat/c/{convId}?msg={msgId}
 *
 * Returns null when the URL is not a message link we can resolve — the caller then leaves it as a
 * plain external link. Rejects, deliberately:
 *   - non-http(s) schemes (a `javascript:` payload must never reach a click handler)
 *   - a `/chat/c/` link from a DIFFERENT origin — that is another deployment, and resolving it
 *     locally would jump to whatever unrelated conversation shares that id here
 *   - a non-numeric message id — Teams message ids are arrival-ms, and anything else is either
 *     junk or a traversal attempt
 */
export function parseMessageUrl(raw: string, origin: string): MessageUrlTarget | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null

  // Teams native: /l/message/{convId}/{msgId}
  if (isTeamsHost(url.hostname)) {
    const m = url.pathname.match(/^\/l\/message\/([^/]+)\/([^/]+)\/?$/)
    if (!m) return null
    return target(decodePath(m[1]), decodePath(m[2]))
  }

  // This app's own deep link: {origin}/chat/c/{convId}?msg={msgId}
  if (url.origin === origin) {
    const m = url.pathname.match(/^\/chat\/c\/([^/]+)\/?$/)
    if (!m) return null
    const msgId = url.searchParams.get("msg")
    if (!msgId) return null
    return target(decodePath(m[1]), msgId)
  }

  return null
}

// The href is authored by whoever sent the message, so a malformed %-escape is expected input, not
// an impossible state — decodeURIComponent throws a URIError on one. Returning null keeps the
// contract ("not a message link we can resolve" → the link stays external) instead of letting the
// throw escape into the click handler.
function decodePath(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

function target(convId: string | null, msgId: string | null): MessageUrlTarget | null {
  if (!convId || !msgId || !/^\d+$/.test(msgId)) return null
  return { convId, msgId }
}
