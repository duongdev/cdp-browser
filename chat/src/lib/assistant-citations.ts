// Pure citation-marker parsing for the assistant panel (t174, ADR-0021 decision 3). The server
// validates markers; the FE strips them from the displayed markdown and renders the collected
// citations as chips under the message. Malformed markers degrade to removed text, never a crash.

export interface CitationRef {
  convId: string
  msgId: string
}

/** What a cited message actually SAYS — five chips reading "Trainer Guru Tech Core Team" five times
 *  tell you nothing (steering). The retrieval tools already stamp every row with sender/ts/text, and
 *  those rows are in this same message's tool parts, so the detail is free: no extra fetch. */
export interface CitationMeta {
  sender?: string
  ts?: number
  text?: string
}

export const citationKey = (c: CitationRef) => `${c.convId}\n${c.msgId}`

/** Harvest `{convId, msgId, sender, ts, snippet|text}` rows out of a message's tool outputs.
 *  Shape-driven, not tool-name-driven, so a new retrieval tool is covered for free. Bounded depth —
 *  tool results are small by design. */
export function collectCitationMeta(parts: unknown[]): Map<string, CitationMeta> {
  const out = new Map<string, CitationMeta>()
  const walk = (value: unknown, depth: number): void => {
    if (depth > 5 || value == null || typeof value !== "object") return
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1)
      return
    }
    const o = value as Record<string, unknown>
    if (typeof o.convId === "string" && typeof o.msgId === "string") {
      const key = citationKey({ convId: o.convId, msgId: o.msgId })
      // First row wins: search snippets come before a later get_context re-read of the same id.
      if (!out.has(key)) {
        out.set(key, {
          sender: typeof o.sender === "string" ? o.sender : undefined,
          ts: typeof o.ts === "number" ? o.ts : undefined,
          text: typeof o.snippet === "string" ? o.snippet : stringOrUndefined(o.text),
        })
      }
    }
    for (const v of Object.values(o)) walk(v, depth + 1)
  }
  for (const part of parts || []) {
    const p = part as { type?: string; output?: unknown }
    if (typeof p?.type !== "string") continue
    if (!p.type.startsWith("tool-") && p.type !== "dynamic-tool") continue
    walk(p.output, 0)
  }
  return out
}

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

/** One line of chip text: "Sender: what they said…", falling back to the conversation name when the
 *  tool rows don't cover this citation (e.g. a marker replayed from an older, compacted turn). */
export function citationChipLabel(meta: CitationMeta | undefined, convLabel: string): string {
  const who = meta?.sender?.trim()
  const said = meta?.text?.replace(/\s+/g, " ").trim()
  if (who && said) return `${who}: ${said}`
  if (who) return who
  return convLabel
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
