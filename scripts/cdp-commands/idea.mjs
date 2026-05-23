// Prepend a timestamped idea to docs/memories/ideas.md. The file is a header,
// a lone `---` separator, then one-line entries newest-first; a new idea is
// inserted directly after the separator so it becomes the top entry.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/** Local-time `YYYY-MM-DD HH:MM`. */
function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`
}

/**
 * Prepend a new idea entry as the top of the entry list.
 * @param {string} text  the idea, trimmed and inserted verbatim
 * @param {{baseDir: string}} opts  docs/memories directory
 * @returns {string} absolute path of the updated file
 */
export function addIdea(text, { baseDir }) {
  const body = String(text ?? "").trim()
  if (!body) throw new Error("idea text is required")

  const file = join(baseDir, "ideas.md")
  const lines = readFileSync(file, "utf8").split("\n")
  const sep = lines.indexOf("---")
  if (sep === -1) throw new Error(`no '---' separator in ${file}`)

  lines.splice(sep + 1, 0, "", `${stamp()} ${body}`)
  writeFileSync(file, lines.join("\n"))
  return file
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const text = process.argv.slice(2).join(" ").trim()
  if (!text) {
    process.stderr.write('usage: idea.mjs "<text>"\n')
    process.exit(1)
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
  const baseDir = join(repoRoot, "docs", "memories")
  if (!existsSync(join(baseDir, "ideas.md"))) {
    process.stderr.write(`missing ${join(baseDir, "ideas.md")}\n`)
    process.exit(1)
  }
  process.stdout.write(`${addIdea(text, { baseDir })}\n`)
}
