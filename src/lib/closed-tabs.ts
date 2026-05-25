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

/**
 * Tracks closed tabs of either kind so Cmd+Shift+T reopens the most recently
 * closed one in its original kind, preserving close order across CDP and local.
 */
export function createClosedStack(): ClosedStack {
  const entries: ClosedEntry[] = []
  return {
    push: (entry) => void entries.push(entry),
    pop: () => entries.pop(),
  }
}
