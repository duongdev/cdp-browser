// t182/t183 mutation check: revert each production change in turn and assert the matching test goes
// RED. A green suite that is not actually wired to the behaviour it names is worse than no suite.
//
// t184 (jump landing settle) has no pure core to mutate — it is DOM scroll behaviour, verified by
// manual smoke instead. See docs/tasks/done/184-jump-landing-media-settle.md.
import { execSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"

const mutants = [
  // ---- t182: attachment mentions + quotes -------------------------------------------------
  {
    src: "core/teams-send-props.js",
    test: "core/teams-send-props.test.ts",
    name: "t182 mention entries lose the load-bearing @type",
    from: '"@type": "http://schema.skype.com/Mention",',
    to: "",
    expect: "five load-bearing fields",
  },
  {
    src: "core/teams-send-props.js",
    test: "core/teams-send-props.test.ts",
    name: "t182 mention entries lose mentionType",
    from: 'mentionType: "person",',
    to: "",
    expect: "five load-bearing fields",
  },
  {
    src: "core/teams-send-props.js",
    test: "core/teams-send-props.test.ts",
    name: "t182 mentions sent as an array instead of a JSON string",
    from: "properties.mentions = JSON.stringify(",
    to: "properties.mentions = (",
    expect: "serializes mentions",
  },
  {
    src: "core/teams-send-props.js",
    test: "core/teams-send-props.test.ts",
    name: "t182 mri-less mention forwarded instead of dropped",
    from: "const usable = mentions.filter((m) => m?.mri)",
    to: "const usable = mentions",
    expect: "notifies nobody",
  },
  {
    src: "core/teams-send-props.js",
    test: "core/teams-send-props.test.ts",
    name: "t182 quotes lose hasValidMsgReferences",
    from: "properties.hasValidMsgReferences = true",
    to: "",
    expect: "quoted reply",
  },
  {
    src: "core/teams-send-props.js",
    test: "core/teams-send-props.test.ts",
    name: "t182 caption html escaped instead of sent verbatim (kills mention spans)",
    from: "if (html && String(html).trim()) return html",
    to: "if (false) return html",
    expect: "mention spans survive",
  },
  {
    src: "core/teams-send-props.js",
    test: "core/teams-send-props.test.ts",
    name: "t182 extra properties (the file chip payload) dropped",
    from: "return { ...properties, ...extra }",
    to: "return properties",
    expect: "file chip",
  },
  {
    src: "core/teams-ams.js",
    test: "core/teams-ams.test.ts",
    name: "t182 AMS caption html ignored (mention spans get escaped)",
    from: "if (captionHtml && String(captionHtml).trim()) return `${captionHtml}<br>`",
    to: "if (false) return ``",
    expect: "verbatim",
  },

  // ---- t183: message link resolution ------------------------------------------------------
  {
    src: "chat/src/lib/message-url.ts",
    test: "chat/src/lib/message-url.test.ts",
    name: "t183 host allowlist becomes a suffix check (lookalike host accepted)",
    from: "return TEAMS_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))",
    to: "return TEAMS_HOSTS.some((h) => host.endsWith(h))",
    expect: "lookalike host",
  },
  {
    src: "chat/src/lib/message-url.ts",
    test: "chat/src/lib/message-url.test.ts",
    name: "t183 subdomain match dropped (regional hosts stop resolving)",
    from: "return TEAMS_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))",
    to: "return TEAMS_HOSTS.some((h) => host === h)",
    expect: "genuine subdomain",
  },
  {
    src: "chat/src/lib/message-url.ts",
    test: "chat/src/lib/message-url.test.ts",
    name: "t183 scheme guard removed (ftp: reaches the handler)",
    from: 'if (url.protocol !== "https:" && url.protocol !== "http:") return null',
    to: "",
    expect: "non-http(s) schemes",
  },
  {
    src: "chat/src/lib/message-url.ts",
    test: "chat/src/lib/message-url.test.ts",
    name: "t183 same-origin check removed for /chat/c/ links",
    from: "if (url.origin === origin) {",
    to: "if (true) {",
    expect: "different origin",
  },
  {
    src: "chat/src/lib/message-url.ts",
    test: "chat/src/lib/message-url.test.ts",
    name: "t183 message id no longer required to be numeric",
    from: "if (!convId || !msgId || !/^\\d+$/.test(msgId)) return null",
    to: "if (!convId || !msgId) return null",
    expect: "not digits",
  },
  {
    src: "chat/src/lib/message-url.ts",
    test: "chat/src/lib/message-url.test.ts",
    name: "t183 percent-encoded conversation id left encoded",
    from: "return target(decodePath(m[1]), decodePath(m[2]))",
    to: "return target(m[1], m[2])",
    expect: "percent-encoded",
  },
  {
    src: "chat/src/lib/message-url.ts",
    test: "chat/src/lib/message-url.test.ts",
    name: "t183 malformed percent-escape throws out of the click handler",
    from: "  try {\n    return decodeURIComponent(segment)\n  } catch {\n    return null\n  }",
    to: "  return decodeURIComponent(segment)",
    expect: "malformed percent-encoding",
  },
  {
    src: "chat/src/lib/message-url.ts",
    test: "chat/src/lib/message-url.test.ts",
    name: "t183 a chat link with no ?msg= resolves to a bogus target",
    from: 'const msgId = url.searchParams.get("msg")\n    if (!msgId) return null',
    to: 'const msgId = url.searchParams.get("msg") || "0"',
    expect: "no ?msg=",
  },

  // ---- t182/t183 follow-ups from the polish pass -------------------------------------------
  {
    src: "chat/src/lib/send-chain.ts",
    test: "chat/src/lib/send-chain.test.ts",
    name: "t182 caption keyed on truthiness, so an empty server id resends it",
    from: "return landed === null",
    to: "return !landed",
    expect: "empty id as landed",
  },
  {
    src: "chat/src/lib/message-link-affordance.ts",
    test: "chat/src/lib/message-link-affordance.test.ts",
    name: "t183 every anchor tagged as in-app, not just resolvable ones",
    from: "if (!target) continue",
    to: "if (false) continue",
    expect: "external link alone",
  },
  {
    src: "chat/src/lib/message-link-affordance.ts",
    test: "chat/src/lib/message-link-affordance.test.ts",
    name: "t183 jump hint overwrites an author-supplied title",
    from: 'if (!a.hasAttribute("title")) a.setAttribute("title", "Open this message in Chats")',
    to: 'a.setAttribute("title", "Open this message in Chats")',
    expect: "existing title",
  },
]

const originals = new Map()
const read = (p) => {
  if (!originals.has(p)) originals.set(p, readFileSync(p, "utf8"))
  return originals.get(p)
}
const restore = () => {
  for (const [p, text] of originals) writeFileSync(p, text)
}

let survived = 0
for (const m of mutants) {
  const original = read(m.src)
  if (!original.includes(m.from)) {
    console.log(`SKIP      ${m.name} — anchor not found (rewrite the mutant)`)
    survived++
    continue
  }
  writeFileSync(m.src, original.replace(m.from, m.to))
  let red = false
  let out = ""
  try {
    out = execSync(`npx vitest run ${m.test} --reporter=dot 2>&1`, {
      encoding: "utf8",
      stdio: "pipe",
    })
  } catch (e) {
    red = true
    out = (e.stdout || "") + (e.stderr || "")
  }
  writeFileSync(m.src, original)
  const hit = out.includes(m.expect)
  console.log(
    `${red ? "KILLED  " : "SURVIVED"}  ${m.name}${red && !hit ? "  (!! red, but not in the expected suite)" : ""}`,
  )
  if (!red) survived++
}
restore()
console.log(`\n${mutants.length - survived}/${mutants.length} mutants killed`)
process.exit(survived === 0 ? 0 : 1)
