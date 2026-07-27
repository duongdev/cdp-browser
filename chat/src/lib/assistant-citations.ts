// Pure citation-marker parsing for the assistant panel (t174, ADR-0021 decision 3). The server
// validates markers; the FE strips them from the displayed markdown and renders the collected
// citations as chips under the message. Malformed markers degrade to removed text, never a crash.

export interface CitationRef {
  convId: string
  msgId: string
}

const MARKER_RE = /\[msg:([^\]]+)\]/g

// convId may contain ':' (Teams thread ids) — split on the LAST colon.
function parseMarker(inner: string): CitationRef | null {
  const i = inner.lastIndexOf(":")
  if (i <= 0 || i === inner.length - 1) return null
  return { convId: inner.slice(0, i), msgId: inner.slice(i + 1) }
}

/** Strip all [msg:convId:msgId] markers from `text`; return the display text + the ordered,
 *  deduped citations. */
export function extractCitations(text: string): { text: string; citations: CitationRef[] } {
  const citations: CitationRef[] = []
  const seen = new Set<string>()
  const cleaned = (text || "").replace(MARKER_RE, (_whole, inner: string) => {
    const c = parseMarker(inner)
    if (c) {
      const key = `${c.convId}\n${c.msgId}`
      if (!seen.has(key)) {
        seen.add(key)
        citations.push(c)
      }
    }
    return ""
  })
  // Collapse doubled spaces the removal leaves behind (marker mid-sentence); drop stray reasoning
  // tag remnants GLM-through-router occasionally leaks into the text stream (live-observed t173).
  return { text: cleaned.replace(/<\/?think>/g, "").replace(/ {2,}/g, " "), citations }
}
