/** A tab activation, identified across both kinds. */
export interface ActiveRef {
  kind: "cdp" | "local"
  id: string
}

const key = (e: ActiveRef) => `${e.kind}:${e.id}`

/**
 * Most-recently-used activation order (oldest → newest). `touchActive` records a
 * tab becoming active; `mostRecent` answers "what should become active when the
 * current tab closes" — the previous active tab that's still open, not just the
 * next one in the list.
 */
export function touchActive(order: ActiveRef[], entry: ActiveRef): ActiveRef[] {
  const k = key(entry)
  return [...order.filter((e) => key(e) !== k), entry]
}

export function dropActive(order: ActiveRef[], entry: ActiveRef): ActiveRef[] {
  const k = key(entry)
  return order.filter((e) => key(e) !== k)
}

/** Newest entry (scanning from the end) for which `isOpen` is true. */
export function mostRecent(
  order: ActiveRef[],
  isOpen: (e: ActiveRef) => boolean,
): ActiveRef | undefined {
  for (let i = order.length - 1; i >= 0; i--) {
    if (isOpen(order[i])) return order[i]
  }
  return undefined
}
