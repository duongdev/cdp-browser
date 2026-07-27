// Citation validation (t173, ADR-0021 decision 3): citations are validated, not trusted. The
// model cites via inline `[msg:{convId}:{msgId}]` markers; the server keeps only markers whose
// (convId, msgId) was actually surfaced by a tool call in this session and strips the rest.
// Pure — no DB, no model.

export interface Citation {
  convId: string
  msgId: string
}

export const citationKey = (c: Citation) => [c.convId, c.msgId].join("\n")

// convId may contain ':' (Teams ids are "19:...@thread"), so split the marker on the LAST colon.
const MARKER_RE = /\[msg:([^\]]+)\]/g

function parseMarker(inner: string): Citation | null {
  const i = inner.lastIndexOf(":")
  if (i <= 0 || i === inner.length - 1) return null
  return { convId: inner.slice(0, i), msgId: inner.slice(i + 1) }
}

/** Collect (convId, msgId) pairs surfaced by tool results inside stored UIMessage parts. Tool
 *  output rows are stamped with convId+msgId by the tool layer; anything shaped that way counts. */
export function surfacedIdsFromMessages(messages: { parts: unknown[] }[]): Set<string> {
  const set = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.parts || []) {
      const p = part as { type?: string; output?: unknown }
      if (typeof p?.type !== "string") continue
      if (!p.type.startsWith("tool-") && p.type !== "dynamic-tool") continue
      collectIds(p.output, set)
    }
  }
  return set
}

/** Deep-scan a tool output for `{convId, msgId}`-shaped rows (bounded depth — tool results are
 *  small by design). */
export function collectIds(value: unknown, set: Set<string>, depth = 0): void {
  if (depth > 4 || value == null || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const v of value) collectIds(v, set, depth + 1)
    return
  }
  const o = value as Record<string, unknown>
  if (typeof o.convId === "string" && typeof o.msgId === "string") {
    set.add(citationKey({ convId: o.convId, msgId: o.msgId }))
  }
  for (const v of Object.values(o)) collectIds(v, set, depth + 1)
}

/** GLM-through-router quirk (live-observed t173): reasoning tags occasionally leak into the text
 *  stream as stray `</think>` remnants. Strip them from anything user-visible. */
export function stripReasoningRemnants(text: string): string {
  return (text || "").replace(/<\/?think>/g, "")
}

/** Strip markers not in the surfaced set; return the cleaned text + the citations kept (deduped,
 *  in order of first appearance). Malformed markers are stripped (degrade to plain text). */
export function validateCitations(
  text: string,
  surfaced: Set<string>,
): { text: string; citations: Citation[] } {
  const kept: Citation[] = []
  const seen = new Set<string>()
  const cleaned = (text || "").replace(MARKER_RE, (whole, inner: string) => {
    const c = parseMarker(inner)
    if (!c) return ""
    const key = citationKey(c)
    if (!surfaced.has(key)) return ""
    if (!seen.has(key)) {
      seen.add(key)
      kept.push(c)
    }
    return whole
  })
  return { text: cleaned, citations: kept }
}
