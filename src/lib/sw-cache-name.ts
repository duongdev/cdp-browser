// Per-build service-worker cache identity. A new build ships a new name so the SW's
// `activate` handler can purge every older cache (see public/sw.js). Kept pure + tested
// here; public/sw.js inlines the same two rules (it's static JS, can't import this).

const PREFIX = "cdp-portal-"

/** "cdp-portal-0.1.0-ab12cd3"; drops the sha when absent; never a bare prefix. */
export function cacheNameFor(version: string, sha?: string): string {
  const v = version || "unknown"
  return sha ? `${PREFIX}${v}-${sha}` : `${PREFIX}${v}`
}

/** Owns only `cdp-portal-*` names: a stale cache is one of ours that is not `current`. */
export function isStaleCache(name: string, current: string): boolean {
  return name.startsWith(PREFIX) && name !== current
}
