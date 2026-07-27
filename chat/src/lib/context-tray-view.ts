// Pure read model for the attach tray's collapsed header (PSN-104 steering). The tray sits directly
// above the composer, so a long attach list used to push the input down the panel; it now collapses
// to one line that still says WHAT is attached, and expands into a bounded, scrollable list.

import type { AssistantContextRef } from "./assistant-client"

/** Collapsed-header summary: "2 chats · 1 folder". Kinds keep a fixed order so the line doesn't
 *  reshuffle as chips are added; only non-empty kinds appear. */
export function summarizeRefs(refs: AssistantContextRef[]): string {
  const counts = { chat: 0, message: 0, folder: 0, label: 0 }
  for (const r of refs) counts[r.kind] = (counts[r.kind] ?? 0) + 1
  const nouns: [keyof typeof counts, string, string][] = [
    ["chat", "chat", "chats"],
    ["message", "message", "messages"],
    ["folder", "folder", "folders"],
    ["label", "label", "labels"],
  ]
  return nouns
    .filter(([k]) => counts[k] > 0)
    .map(([k, one, many]) => `${counts[k]} ${counts[k] === 1 ? one : many}`)
    .join(" · ")
}

/** How many chips show before the tray defaults to collapsed. One or two chips are worth their
 *  vertical space; a pile of them is not. */
export const TRAY_AUTO_COLLAPSE_OVER = 2

/** Initial open state for a tray holding `count` refs. */
export function defaultTrayOpen(count: number): boolean {
  return count > 0 && count <= TRAY_AUTO_COLLAPSE_OVER
}
