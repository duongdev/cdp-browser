// Extract risk entries from docs/memories/risks.md. Headings look like:
//   ### R-001 — CDP screencast drops … 🟡
// Status is the trailing legend emoji. Returned in document order (which is
// NOT R-number order — the file intentionally keeps related risks together).

const STATUS = ["🔴", "🟡", "🟢", "✅", "💥"]
const HEADING = new RegExp(
  String.raw`^###\s+(R-\d+)\s+—\s+(.+?)\s+(${STATUS.join("|")})\s*$`,
  "gmu",
)

/**
 * @param {string} content   raw risks.md markdown
 * @returns {{id: string, title: string, status: string}[]}
 */
export function parseRisks(content) {
  const out = []
  for (const m of content.matchAll(HEADING)) {
    out.push({ id: m[1], title: m[2].trim(), status: m[3] })
  }
  return out
}

/** Open risks only (🔴), in document order. */
export function parseOpenRisks(content) {
  return parseRisks(content).filter((r) => r.status === "🔴")
}
