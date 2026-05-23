// Scaffold a new docs/tasks/ file from the task TEMPLATE. The next task number
// is the max 3-digit prefix across BOTH docs/tasks/ and docs/tasks/done/ + 1,
// so numbering stays globally unique even after files move to done/. Only the
// first-line title is filled — the human writes the rest.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { findUniquePath } from "./lib/find-unique-path.mjs"
import { nextNumber } from "./lib/next-number.mjs"
import { slug } from "./lib/slug.mjs"

const TASK_NUM = /^(\d{3})-/

/** Markdown filenames in `dir`, or `[]` if the directory is absent. */
function mdNames(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((n) => n.endsWith(".md"))
}

/**
 * Create the next-numbered task file from the template.
 * @param {string} title  human title, used verbatim on the first line
 * @param {{tasksDir: string, doneDir: string, templatePath: string}} opts
 * @returns {string} absolute path of the created file
 */
export function scaffoldTask(title, { tasksDir, doneDir, templatePath }) {
  const text = String(title ?? "").trim()
  if (!text) throw new Error("task title is required")

  const existing = [...mdNames(tasksDir), ...mdNames(doneDir)]
  const num = nextNumber(existing, { pattern: TASK_NUM, pad: 3 })
  const path = findUniquePath(tasksDir, `${num}-${slug(text)}`, ".md")

  const template = readFileSync(templatePath, "utf8")
  const filled = template.replace(/^#.*$/m, `# ${num} — ${text}`)
  writeFileSync(path, filled)
  return path
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const title = process.argv.slice(2).join(" ").trim()
  if (!title) {
    process.stderr.write('usage: new-task.mjs "<title>"\n')
    process.exit(1)
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
  const tasksDir = join(repoRoot, "docs", "tasks")
  const doneDir = join(tasksDir, "done")
  const templatePath = join(tasksDir, "TEMPLATE.md")
  process.stdout.write(`${scaffoldTask(title, { tasksDir, doneDir, templatePath })}\n`)
}
