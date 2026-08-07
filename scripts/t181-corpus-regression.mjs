// t181 corpus regression: run the captured probe corpus through the real renderer and assert
// every gap class the task set out to close now reports ZERO.
//
// Usage: node scripts/t181-corpus-regression.mjs /path/to/raw_all.json
// The corpus is a raw Teams messages-API dump (read-only probe, not committed — it is live chat data).
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { toReaderMessages, parseAttachments } = require("../core/teams-render.js")

const corpusPath = process.argv[2]
if (!corpusPath) {
  console.error("usage: node scripts/t181-corpus-regression.mjs <raw_all.json>")
  process.exit(2)
}

const jparse = (v) => {
  if (typeof v !== "string") return v
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}
const plain = (h) =>
  String(h || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()

const raw = JSON.parse(readFileSync(corpusPath, "utf8"))
const rendered = toReaderMessages(raw, "")
const byId = new Map(rendered.map((m) => [String(m.id), m]))

const fail = {}
const flag = (k, id) => {
  if (!fail[k]) fail[k] = []
  fail[k].push(id)
}

for (const m of raw) {
  const id = String(m.id || "")
  const content = typeof m.content === "string" ? m.content : ""
  const props = m.properties || {}
  const r = byId.get(id)
  if (!r) continue
  const body = r.body || ""
  const atts = parseAttachments(m)

  // A — an image upload must render as an inline image, not a filename chip.
  for (const f of jparse(props.files) || []) {
    const t = String(f?.fileType || "").toLowerCase()
    const isImage = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic"].includes(t)
    if (!isImage) continue
    if (!f?.filePreview?.previewUrl) continue
    if (!atts.some((a) => a.kind === "image" && a.thumbnailUrl))
      flag("A image upload still a chip", id)
  }

  // B — a Loop/Fluid embed must surface a chip; an auto-embed anchor must carry a label.
  const hasFluidCard = (jparse(props.cards) || []).some((c) =>
    /fluidEmbedCard/i.test(String(c?.contentType || "")),
  )
  if (hasFluidCard && !atts.some((a) => a.kind === "card" && a.url))
    flag("B Loop embed dropped", id)
  if (/FluidAutoEmbedLink/i.test(content)) {
    const empty = /itemtype="[^"]*FluidAutoEmbedLink[^"]*"[^>]*>\s*<\/a>/i.test(body)
    if (empty) flag("B FluidAutoEmbedLink still invisible", id)
  }

  // C — a video-only message must keep its <video>.
  if (/itemtype="[^"]*AMSVideo/i.test(content) && !/<video/i.test(body))
    flag("C video-only body empty", id)

  // D — a SWIFT card must show decoded text, not the generic <Title>.
  if (/<Swift\b[^>]*b64="[^"]+"/i.test(content)) {
    const card = atts.find((a) => a.kind === "card")
    if (!card || (!card.text && /^(Card|New polly!)$/i.test(card.title || "")))
      flag("D Swift card still generic", id)
  }

  // E — a forwarded blockquote must be marked.
  if (/itemtype="[^"]*Forward/i.test(content) && !/blockquote class="forward"/i.test(body))
    flag("E forward unlabelled", id)

  // Overall: no bubble may render with nothing at all.
  if (
    r.kind !== "system" &&
    !r.deleted &&
    atts.length === 0 &&
    plain(body).length === 0 &&
    !/<img|<video/i.test(body)
  )
    flag("blank bubble", id)
}

console.log(`corpus: ${raw.length} raw → ${rendered.length} rendered\n`)
const keys = Object.keys(fail)
if (keys.length === 0) {
  console.log("all t181 gap classes report 0 — PASS")
  process.exit(0)
}
for (const k of keys)
  console.log(
    `${String(fail[k].length).padStart(5)}  ${k}\n        e.g. ${fail[k].slice(0, 3).join(", ")}`,
  )
process.exit(1)
