// Scaffold a new docs/adr/ file from the ADR TEMPLATE. The next ADR number is
// the max 4-digit prefix across docs/adr/ + 1. Only the title, Status, and
// Date header lines are filled — the human writes Context/Decision/etc.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { findUniquePath } from "./lib/find-unique-path.mjs"
import { nextNumber } from "./lib/next-number.mjs"
import { slug } from "./lib/slug.mjs"

const ADR_NUM = /^(\d{4})-/

/** Local-time `YYYY-MM-DD`. */
function today(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

/** Markdown filenames in `dir`, or `[]` if the directory is absent. */
function mdNames(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((n) => n.endsWith(".md"))
}

/**
 * Create the next-numbered ADR file from the template.
 * @param {string} title  human title, used verbatim on the first line
 * @param {{adrDir: string, templatePath: string}} opts
 * @returns {string} absolute path of the created file
 */
export function scaffoldAdr(title, { adrDir, templatePath }) {
  const text = String(title ?? "").trim()
  if (!text) throw new Error("ADR title is required")

  const num = nextNumber(mdNames(adrDir), { pattern: ADR_NUM, pad: 4 })
  const path = findUniquePath(adrDir, `${num}-${slug(text)}`, ".md")

  const filled = readFileSync(templatePath, "utf8")
    .replace(/^#.*$/m, `# ADR-${num}: ${text}`)
    .replace(/^- \*\*Status:\*\*.*$/m, "- **Status:** Proposed")
    .replace(/^- \*\*Date:\*\*.*$/m, `- **Date:** ${today()}`)
  writeFileSync(path, filled)
  return path
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const title = process.argv.slice(2).join(" ").trim()
  if (!title) {
    process.stderr.write('usage: adr.mjs "<title>"\n')
    process.exit(1)
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
  const adrDir = join(repoRoot, "docs", "adr")
  const templatePath = join(adrDir, "TEMPLATE.md")
  process.stdout.write(`${scaffoldAdr(title, { adrDir, templatePath })}\n`)
}
