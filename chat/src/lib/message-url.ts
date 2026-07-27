// Pure message URL builders (PSN-105 E). Used by the "Copy link" / "Copy Teams link" menu items.

/** App-internal message deep link: opens /chat/c/{convId} and jumps to {msgId}.
 *  The `?msg=` param is already consumed by chat-app.tsx (t175 cold deep-link handler).
 * @param origin - pass `window.location.origin` in the browser, or a string for tests. */
export function buildChatMessageUrl(convId: string, msgId: string, origin: string): string {
  return `${origin}/chat/c/${convId}?msg=${msgId}`
}

/** Teams native deep-link format.
 *
 * ponytail: This format is UNVERIFIED — derived from observed Teams URL patterns and the
 * ms-teams: URI scheme documentation. The `tenantId`, `groupId`, `parentMessageId`,
 * `teamName`, `channelName` fields are left empty (correct for DMs/group chats); the
 * `createdTime` field mirrors `msgId` which Teams uses as the OriginalArrivalTime (ms).
 * Confirm against a live Teams client before relying on this link opening correctly.
 * If unverifiable, remove this function and drop the "Copy Teams link" menu item.
 */
export function buildTeamsMessageUrl(convId: string, msgId: string): string {
  return `https://teams.microsoft.com/l/message/${convId}/${msgId}?tenantId=&groupId=&parentMessageId=&teamName=&channelName=&createdTime=${msgId}`
}
