// Caption ownership in a multi-file send (t182). Pure.
//
// A message with several attachments becomes a CHAIN of sends, but the caption — and with it the
// reply quotes and @mentions — belongs to exactly ONE message in that chain. Which one is not
// knowable up front: an upload can fail, and attaching the caption to a message that never lands
// loses the mentions silently, which is the exact failure t182 exists to remove.
//
// So the decision is made per step against what has already LANDED, never against a loop index.

/**
 * Does the next send in the chain carry the caption (plus its quotes and mentions)?
 *
 * `landed` is the id of the first message that made it to the server, or null while none has. A
 * failed attempt leaves it null, so the caption moves to the next attempt instead of being lost.
 */
export function carriesCaption(landed: string | null): boolean {
  return landed === null
}
