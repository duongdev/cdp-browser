// Append a new risk entry to docs/memories/risks.md.
// Next R-number is max+1 over every existing `### R-\d+` heading
// (the file is intentionally NOT R-number ordered), so numbering is
// order-independent via the shared nextNumber helper.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { nextNumber } from "./lib/next-number.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const RISKS_FILE = join(ROOT, "docs", "memories", "risks.md")
const HEADING = /### R-(\d+)/g

/**
 * Append a new open (🔴) risk entry and return its id.
 * @param {string} text   risk title / one-line description
 * @param {{risksFile: string}} opts   path to risks.md
 * @returns {{file: string, id: string}}
 */
export function addRisk(text, { risksFile }) {
  const title = String(text ?? "").trim()
  if (!title) throw new Error("risk title is required")

  const content = readFileSync(risksFile, "utf8")
  const num = nextNumber(content.match(HEADING) ?? [], {
    pattern: /R-(\d+)/,
    pad: 3,
  })
  const id = `R-${num}`

  const block = [
    "",
    `### ${id} — ${title} 🔴`,
    "",
    "_To be filled._",
    "",
    "**Mitigation:**",
    "- _TBD_",
    "",
    "**Trigger to escalate:** _TBD_",
    "",
  ].join("\n")

  writeFileSync(risksFile, `${content.replace(/\n+$/, "\n")}${block}`)
  return { file: risksFile, id }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const title = process.argv.slice(2).join(" ").trim()
  if (!title) {
    process.stderr.write('usage: risk.mjs "<title>"\n')
    process.exit(1)
  }
  if (!existsSync(RISKS_FILE)) {
    process.stderr.write(`missing ${RISKS_FILE}\n`)
    process.exit(1)
  }
  try {
    const { file, id } = addRisk(title, { risksFile: RISKS_FILE })
    process.stdout.write(`${file}\n${id}\n`)
  } catch (err) {
    process.stderr.write(`risk.mjs failed: ${err.message}\n`)
    process.exit(1)
  }
}
