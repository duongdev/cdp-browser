// Prepend a timestamped learning to docs/memories/learnings.md. The file is a
// header, a lone `---` separator, then paragraph entries newest-first, each
// entry fenced by `---` separators. A new learning is inserted directly after
// the leading separator so it becomes the top entry.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/** Local-time `YYYY-MM-DD`. */
function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

/**
 * Prepend a new learning entry as the top of the entry list.
 * @param {string} text  the learning, trimmed and inserted verbatim
 * @param {{baseDir: string}} opts  docs/memories directory
 * @returns {string} absolute path of the updated file
 */
export function addLearning(text, { baseDir }) {
  const body = String(text ?? "").trim()
  if (!body) throw new Error("learning text is required")

  const file = join(baseDir, "learnings.md")
  const lines = readFileSync(file, "utf8").split("\n")
  const sep = lines.indexOf("---")
  if (sep === -1) throw new Error(`no '---' separator in ${file}`)

  lines.splice(sep + 1, 0, "", `${stamp()} — ${body}`, "", "---")
  writeFileSync(file, lines.join("\n"))
  return file
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const text = process.argv.slice(2).join(" ").trim()
  if (!text) {
    process.stderr.write('usage: learn.mjs "<text>"\n')
    process.exit(1)
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
  const baseDir = join(repoRoot, "docs", "memories")
  if (!existsSync(join(baseDir, "learnings.md"))) {
    process.stderr.write(`missing ${join(baseDir, "learnings.md")}\n`)
    process.exit(1)
  }
  process.stdout.write(`${addLearning(text, { baseDir })}\n`)
}
