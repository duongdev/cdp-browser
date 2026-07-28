/**
 * Shift+Enter action for the composer (PSN-113 A, D1).
 * Outside a list/code block, Shift+Enter splits the block (new paragraph) so a
 * `- ` / `1. ` typed afterwards converts only the new paragraph, not the whole
 * pre-break paragraph. Inside a list item or code block, keep the native
 * behaviour (HardBreak line-break within the item / newline in code).
 */
export function shiftEnterAction(inList: boolean, inCodeBlock: boolean): "splitBlock" | "native" {
  return inList || inCodeBlock ? "native" : "splitBlock"
}
