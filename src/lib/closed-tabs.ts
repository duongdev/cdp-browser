export type ClosedKind = "cdp" | "local"

export interface ClosedEntry {
  kind: ClosedKind
  url: string
}

export interface ClosedStack {
  push(entry: ClosedEntry): void
  /** The most recently closed entry, or undefined when nothing is left. */
  pop(): ClosedEntry | undefined
}

/** Bound on retained closed entries — drops the oldest beyond this. */
export const CLOSED_STACK_CAP = 50

/**
 * Tracks closed tabs of either kind so Cmd+Shift+T reopens the most recently
 * closed one in its original kind, preserving close order across CDP and local.
 * Bounded at `cap` entries (oldest dropped) so a long session can't grow it
 * without limit.
 */
export function createClosedStack(cap = CLOSED_STACK_CAP): ClosedStack {
  const entries: ClosedEntry[] = []
  return {
    push: (entry) => {
      entries.push(entry)
      if (entries.length > cap) entries.shift()
    },
    pop: () => entries.pop(),
  }
}
