// Live markdown shortcuts for the composer (PSN-94 B). Pure matchers over the text before the caret;
// the composer owns the DOM replacement. Teams auto-converts these as you type — this mirrors the
// common subset: **bold**, *italic* / _italic_, ~~strike~~, `code`, plus block prefixes `> `, `- `,
// `1. `, and a ``` code fence.

export type InlineTag = "b" | "i" | "s" | "code"

export interface InlineMatch {
  /** Offset in the source text where the raw markdown starts (delete from here to the caret). */
  start: number
  /** The full matched markdown source, e.g. "**hi**". */
  raw: string
  /** The element to wrap the inner text in. */
  tag: InlineTag
  /** The text that survives inside the element. */
  inner: string
}

// Each rule is anchored to the END of the text (the caret just closed the marker). Order matters:
// the longer / more specific markers win first so `**` isn't eaten by the `*` rule, and a code span
// suppresses the others (nothing formats inside backticks).
const INLINE_RULES: { tag: InlineTag; re: RegExp }[] = [
  { tag: "code", re: /`([^`\n]+?)`$/ },
  { tag: "b", re: /\*\*([^*\n]+?)\*\*$/ },
  { tag: "s", re: /~~([^~\n]+?)~~$/ },
  // The opening `*` must not follow another `*`, so a half-typed `**bold*` never converts to italic
  // before the closing `**` lands.
  { tag: "i", re: /(?<!\*)\*([^*\n]+?)\*$/ },
]

/** Match a completed inline markdown span ending at the caret. Returns null when nothing closes. */
export function matchInlineShortcut(text: string): InlineMatch | null {
  for (const { tag, re } of INLINE_RULES) {
    const m = re.exec(text)
    if (m && m[1].trim()) {
      const raw = m[0]
      return { start: text.length - raw.length, raw, tag, inner: m[1] }
    }
  }
  // `_italic_` — only at a word boundary so snake_case / a_b never converts.
  const u = /(^|\s)_([^_\n]+?)_$/.exec(text)
  if (u && u[2].trim()) {
    const raw = `_${u[2]}_`
    return { start: text.length - raw.length, raw, tag: "i", inner: u[2] }
  }
  return null
}

export type BlockKind = "quote" | "ul" | "ol" | "code"

export interface BlockMatch {
  kind: BlockKind
  /** The prefix to strip before applying the block format (e.g. "> ", "- ", "```"). */
  raw: string
}

/** Match a block-level prefix the caret just completed. `line` is the block's text up to the caret;
 *  it must be ONLY the prefix (a fresh line), so mid-line "1. " never triggers. */
export function matchBlockShortcut(line: string): BlockMatch | null {
  if (line === "```") return { kind: "code", raw: "```" }
  if (/^>\s$/.test(line)) return { kind: "quote", raw: line }
  if (/^[-*]\s$/.test(line)) return { kind: "ul", raw: line }
  if (/^\d+\.\s$/.test(line)) return { kind: "ol", raw: line }
  return null
}
