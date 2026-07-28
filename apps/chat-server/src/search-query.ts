// Pure KQL-style search query parser (PSN-115 WS-D). Slack-style operators, whitespace-separated:
//   from:<name>     → filters.from        (leading @ stripped)
//   in:<conv>       → filters.in          (leading # stripped)
//   after:<date>    → filters.afterTs     (epoch ms; ISO date or 4-digit year; unparseable → literal)
//   before:<date>   → filters.beforeTs
//   has:<x>         → filters.has[]       (link|file|attachment today; others pass through)
//   mentions:me     → filters.mentionsMe  (only `me` recognised; other values drop the token)
//   foo:bar         → literal text        (unknown operator never silently dropped)
// Free text (everything else) is concatenated with single spaces. Quoted values
// (`from:"Alice Wong"`, `in:"design review"`) keep their inner whitespace.
//
// No I/O, no clock. Pure so the route's parse step and the FE's chip-render are testable in
// isolation — the FE imports the SAME `ParsedQuery` type to echo filter chips back to the user.

/** Recognised operators. Anything outside this set falls through to literal text. */
const KNOWN_OPS = new Set(["from", "in", "after", "before", "has", "mentions"])

export interface ParsedFilters {
  /** Sender display name or id — the route resolves to a sender_id via `resolvePerson`. */
  from?: string
  /** Conversation name or id — the route resolves to a convId (title/topic/`in:`-literal match). */
  in?: string
  /** Inclusive lower bound, epoch ms. */
  afterTs?: number
  /** Inclusive upper bound, epoch ms. */
  beforeTs?: number
  /** `has:link|file|attachment` accumulator; unknown values pass through for the caller to ignore. */
  has?: string[]
  /** `mentions:me` — the only form recognised today. */
  mentionsMe?: boolean
}

export interface ParsedQuery {
  /** Free-text substring (diacritics intact). Empty when the query was operators-only. */
  text: string
  filters: ParsedFilters
}

/**
 * Tokenise the raw query into `(rawToken, valueOrUndefined)` pairs. Whitespace splits tokens
 * outside double-quotes; a `"..."` span inside a token keeps its inner whitespace as the value.
 * Returns the raw token strings (for literal fallback) alongside the parsed operator/value so the
 * reducer can re-emit an unrecognised operator verbatim.
 */
function tokenise(raw: string): { raw: string; op?: string; value?: string }[] {
  const out: { raw: string; op?: string; value?: string }[] = []
  const s = raw.trim()
  if (!s) return out
  let i = 0
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++
    if (i >= s.length) break
    const start = i
    let tokenEnd: number
    let value: string | undefined
    // Detect a `key:"..."` form: a colon BEFORE any whitespace, immediately followed by `"`.
    const colonAt = s.indexOf(":", i)
    const ws = s.slice(i).search(/\s/)
    const tokenEndNoQuote = ws < 0 ? s.length : i + ws
    if (colonAt !== -1 && colonAt < tokenEndNoQuote && s[colonAt + 1] === '"') {
      // Quoted value: scan from the opening quote to its matching close. The token spans
      // `key:"..."` including the quotes; the parsed value is the inner text (no quotes).
      const quoteStart = colonAt + 1
      const close = s.indexOf('"', quoteStart + 1)
      if (close === -1) {
        // Unterminated quote — treat the whole tail as one literal token (no op/value split).
        tokenEnd = s.length
      } else {
        tokenEnd = close + 1
        value = s.slice(quoteStart + 1, close)
      }
    } else {
      tokenEnd = tokenEndNoQuote
    }
    const rawToken = s.slice(start, tokenEnd)
    let op: string | undefined
    if (value === undefined && colonAt !== -1 && colonAt < tokenEnd) {
      op = s.slice(start, colonAt)
      value = s.slice(colonAt + 1, tokenEnd)
    } else if (value !== undefined) {
      op = s.slice(start, colonAt)
    }
    out.push({ raw: rawToken, op, value })
    i = tokenEnd
  }
  return out
}

/** Lenient date → epoch ms. ISO dates via Date.parse; a bare 4-digit year → Jan 1 UTC. NaN → null. */
function parseDate(raw: string): number | null {
  const v = Date.parse(raw)
  if (!Number.isNaN(v)) return v
  if (/^\d{4}$/.test(raw)) return Date.UTC(Number.parseInt(raw, 10), 0, 1)
  return null
}

/** Parse `raw` into `{ text, filters }`. Idempotent and side-effect-free. */
export function parseQuery(raw: string): ParsedQuery {
  const tokens = tokenise(raw ?? "")
  const textParts: string[] = []
  let from: string | undefined
  let inConv: string | undefined
  let afterTs: number | undefined
  let beforeTs: number | undefined
  let has: string[] | undefined
  let mentionsMe: boolean | undefined

  for (const t of tokens) {
    const op = t.op
    const value = t.value ?? ""
    if (op && KNOWN_OPS.has(op)) {
      switch (op) {
        case "from": {
          // Empty value (e.g. `from:` alone) → literal, not a filter.
          if (!value) break
          from = value.startsWith("@") ? value.slice(1) : value
          continue
        }
        case "in": {
          if (!value) break
          inConv = value.startsWith("#") ? value.slice(1) : value
          continue
        }
        case "after": {
          const ts = parseDate(value)
          if (ts === null) break
          afterTs = ts
          continue
        }
        case "before": {
          const ts = parseDate(value)
          if (ts === null) break
          beforeTs = ts
          continue
        }
        case "has": {
          if (!value) break
          has = has ?? []
          has.push(value)
          continue
        }
        case "mentions": {
          // Only `mentions:me` is meaningful today. Other values are dropped silently (NOT joined
          // to text) — mirrors Slack, which treats `mentions:bob` as a no-op filter.
          if (value === "me") mentionsMe = true
          continue
        }
      }
    }
    // Unrecognised operator OR a recognised operator that failed validation above: re-emit the
    // RAW token (so `foo:bar` and `after:banana` both land as literal searchable text).
    textParts.push(t.raw)
  }

  const filters: ParsedFilters = {}
  if (from !== undefined) filters.from = from
  if (inConv !== undefined) filters.in = inConv
  if (afterTs !== undefined) filters.afterTs = afterTs
  if (beforeTs !== undefined) filters.beforeTs = beforeTs
  if (has !== undefined) filters.has = has
  if (mentionsMe) filters.mentionsMe = true

  return { text: textParts.join(" "), filters }
}
