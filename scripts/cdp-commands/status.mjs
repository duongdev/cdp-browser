// Print a concise session-orientation block: in-progress tasks, top open
// risks, next ready-to-pick tasks. Pure fs reads, no writes — safe to run
// anytime. Repo root is derived from this file's location
// (<root>/scripts/cdp-commands/), never process.cwd().

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseOpenRisks } from "./lib/parse-risks.mjs"
import { parseTaskStatus } from "./lib/parse-task-status.mjs"

const TASK_FILE = /^\d{3}-.+\.md$/
const HEADING = /^#\s+(.+?)\s*$/m
const DEPENDS_ON = /^\s*-?\s*\*\*Depends on:\*\*\s*(.+?)\s*$/m

/**
 * First `# Heading` text with any leading `NNN —`/`NNN -` stripped, or the
 * file's NNN if it has no heading.
 */
function taskTitle(content, num) {
  const m = content.match(HEADING)
  if (!m) return num
  return m[1].trim().replace(/^\d{3,4}\s*[—-]\s*/, "")
}

/** Parsed `- **Depends on:** 001, 003` → ["001", "003"]; none/— → []. */
function dependencyNumbers(content) {
  const m = content.match(DEPENDS_ON)
  if (!m) return []
  const raw = m[1].trim().toLowerCase()
  if (raw === "none" || raw === "—" || raw === "-" || raw === "") return []
  return Array.from(m[1].matchAll(/\d{3}/g), (x) => x[0])
}

/** Read every `NNN-*.md` directly under dir (non-recursive). */
function readTaskDir(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => TASK_FILE.test(f))
    .sort()
    .map((f) => ({
      num: f.slice(0, 3),
      file: f,
      content: readFileSync(join(dir, f), "utf8"),
    }))
}

/**
 * Build the human-readable orientation block.
 * @param {{root: string}} opts  absolute repo root
 * @returns {string} formatted multi-section report
 */
export function buildStatus({ root }) {
  const tasksDir = join(root, "docs", "tasks")
  const doneDir = join(tasksDir, "done")
  const active = readTaskDir(tasksDir)
  const done = readTaskDir(doneDir)
  const doneNums = new Set(done.map((t) => t.num))

  const inProgress = active
    .filter((t) => parseTaskStatus(t.content) === "in-progress")
    .map((t) => `${t.num} — ${taskTitle(t.content, t.num)}`)

  const risksFile = join(root, "docs", "memories", "risks.md")
  const risks = existsSync(risksFile)
    ? parseOpenRisks(readFileSync(risksFile, "utf8"))
        .slice(0, 3)
        .map((r) => `${r.id} — ${r.title}`)
    : []

  const nextReady = active
    .filter((t) => parseTaskStatus(t.content) === "ready")
    .filter((t) => dependencyNumbers(t.content).every((d) => doneNums.has(d)))
    .slice(0, 3)
    .map((t) => `${t.num} — ${taskTitle(t.content, t.num)}`)

  const driftFiles = []
  for (const t of active) {
    if (parseTaskStatus(t.content) === "done") {
      driftFiles.push(`${t.num} header says done but not in done/`)
    }
  }
  for (const t of done) {
    const header = parseTaskStatus(t.content)
    if (header !== null && header !== "done") {
      driftFiles.push(`${t.num} in done/ but header says ${header}`)
    }
  }

  const fmt = (items) => (items.length ? items.map((i) => `  - ${i}`).join("\n") : "  - (none)")

  const out = [
    "In progress:",
    fmt(inProgress),
    "",
    "Top open risks:",
    fmt(risks),
    "",
    "Next ready:",
    fmt(nextReady),
  ]
  if (driftFiles.length) {
    out.push("", `Drift warning: ${driftFiles.join("; ")}`)
  }
  return out.join("\n")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
  console.log(buildStatus({ root }))
}
