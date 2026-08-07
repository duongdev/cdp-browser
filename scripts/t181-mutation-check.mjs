// t181 mutation check: revert each production change in turn and assert the matching test goes RED.
// A green suite that is not actually wired to the behaviour it names is worse than no suite.
import { execSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"

const SRC = "core/teams-render.js"
const original = readFileSync(SRC, "utf8")

const mutants = [
  {
    name: "P1-C hasVisibleText drops <video>",
    from: "if (/<(?:img|video)\\b/i.test(html)) return true",
    to: "if (/<img\\b/i.test(html)) return true",
    expect: "video-only body",
  },
  {
    name: "P1-A image upload never becomes kind:image",
    from: "if (IMAGE_FILE_TYPES.has(type.toLowerCase()) && isValidAmsUrl(preview)) {",
    to: "if (false && preview) {",
    expect: "image uploads",
  },
  {
    name: "P1-A SSRF gate removed (any preview host accepted)",
    from: "IMAGE_FILE_TYPES.has(type.toLowerCase()) && isValidAmsUrl(preview)",
    to: "IMAGE_FILE_TYPES.has(type.toLowerCase()) && !!preview",
    expect: "SSRF gate holds",
  },
  {
    name: "P2-A Swift payload never decoded",
    from: "const decoded = swiftCardText(m[2])",
    to: "const decoded = null",
    expect: "Swift adaptive card",
  },
  {
    name: "P2-A card text cap removed",
    from: 'return { title: title.slice(0, 120), text: rest.join(" · ").slice(0, CARD_TEXT_CAP) }',
    to: 'return { title: title.slice(0, 120), text: rest.join(" · ") }',
    expect: "caps runaway card text",
  },
  {
    name: "P1-B Loop cards not parsed",
    from: 'if (!/fluidEmbedCard/i.test(String(c?.contentType || ""))) continue',
    to: "continue",
    expect: "Loop / Fluid embed",
  },
  {
    name: "P1-B Loop componentUrl scheme check removed",
    from: 'if (typeof url !== "string" || !/^https?:\\/\\//i.test(url)) continue',
    to: 'if (typeof url !== "string") continue',
    expect: "not http(s)",
  },
  {
    name: "P1-B FluidAutoEmbedLink not labelled",
    from: "labelFluidLinks(tagEmoji(",
    to: "((x) => x)(tagEmoji(",
    expect: "FluidAutoEmbedLink",
  },
  {
    name: "P2-B Forward blockquote not labelled",
    from: "labelForwards(\n",
    to: "((x) => x)(\n",
    expect: "forwarded blocks",
  },
  {
    name: "P2-B Forward label reverts to sighted-only (no DOM node)",
    from: '<span class="forward-label">Forwarded</span>',
    to: "",
    expect: "screen readers reach it",
  },
]

let survived = 0
for (const m of mutants) {
  if (!original.includes(m.from)) {
    console.log(`SKIP  ${m.name} — anchor not found (rewrite the mutant)`)
    survived++
    continue
  }
  writeFileSync(SRC, original.replace(m.from, m.to))
  let red = false
  let out = ""
  try {
    out = execSync("npx vitest run core/teams-render.test.ts --reporter=dot 2>&1", {
      encoding: "utf8",
      stdio: "pipe",
    })
  } catch (e) {
    red = true
    out = (e.stdout || "") + (e.stderr || "")
  }
  const hit = out.includes(m.expect)
  console.log(
    `${red ? "KILLED" : "SURVIVED"}  ${m.name}${red && !hit ? "  (!! red, but not in the expected suite)" : ""}`,
  )
  if (!red) survived++
}
writeFileSync(SRC, original)
console.log(`\n${mutants.length - survived}/${mutants.length} mutants killed`)
process.exit(survived === 0 ? 0 : 1)
