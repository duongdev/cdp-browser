// Read a task file's lifecycle status. Physical location wins: anything under
// docs/tasks/done/ is `done` regardless of a stale header. Otherwise the
// `- **Status:** <value>` header line is authoritative (first token only —
// headers like "ready (may split)" normalise to "ready").

const STATUS_LINE = /^\s*-?\s*\*\*Status:\*\*\s*(.+?)\s*$/m

/**
 * @param {string} content   raw task-file markdown
 * @param {{inDoneDir?: boolean}} [opts]
 * @returns {string|null} lowercased status, or null if no header found
 */
export function parseTaskStatus(content, { inDoneDir = false } = {}) {
  if (inDoneDir) return "done"
  const m = content.match(STATUS_LINE)
  if (!m) return null
  return m[1]
    .trim()
    .split(/[\s|(]/)[0]
    .toLowerCase()
}
