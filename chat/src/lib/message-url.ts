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
