// Manual visual-review harness (Layer 3): fake CDP host + web server, with a few
// seeded notifications so the Inbox renders populated. Not part of any automated
// suite — started by hand, stopped with Ctrl+C. Prints the base URL on stdout.

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_TARGETS, startFakeCdpHost } from "./fake-cdp-host.mjs"
import { startWebServer } from "./server-harness.mjs"

const now = Date.now()
const seed = [
  {
    id: "n3",
    adapter: "teams",
    source: "Microsoft Teams",
    title: "Standup",
    body: "Carol: moving standup to 10:30 today",
    targetId: "t-teams",
    targetUrl: "https://teams.microsoft.com/v2/",
    ts: now - 50 * 60_000,
    read: true,
  },
  {
    id: "n2",
    adapter: "slack",
    source: "Example Group Holdings Limited",
    title: "Alex Carter in #team-prs",
    body: "Alex Carter: Hi @Sam Rivers, @Pat Morgan I've created a pull request 123: chore: sync dev to uat and resolve conflicts https://git.example.com/example/repo/pull/123",
    targetId: "t-slack",
    targetUrl: "https://app.slack.com/client/T123/C1",
    groupKey: "slack:T123",
    channelId: "C1",
    slackKind: "channel",
    slackConvo: "team-prs",
    slackMention: true,
    slackTs: "1700000000.000100",
    ts: now - 2 * 60_000,
    read: false,
  },
  {
    id: "n4",
    adapter: "slack",
    source: "Example Group",
    title: "Jordan Lee",
    body: "Jordan Lee: can you review the deploy doc?",
    targetId: "t-slack",
    targetUrl: "https://app.slack.com/client/T9/D1",
    groupKey: "slack:T9",
    channelId: "D1",
    slackKind: "im",
    slackConvo: "Jordan Lee",
    slackMention: false,
    slackTs: "1700000001.000100",
    ts: now - 90_000,
    read: false,
  },
  {
    id: "n1",
    adapter: "slack",
    source: "#release",
    title: "Alice in #release",
    body: "Alice: the 0.3 build is green, shipping after lunch",
    targetId: "t-slack",
    targetUrl: "https://app.slack.com/client/T123/C1",
    groupKey: "slack:T123",
    channelId: "C1",
    ts: now - 4 * 60_000,
    read: false,
  },
]

const seedDir = mkdtempSync(join(tmpdir(), "cdp-visual-"))
const notifsPath = join(seedDir, "notifications.json")
writeFileSync(notifsPath, JSON.stringify(seed))

const host = await startFakeCdpHost({ targets: DEFAULT_TARGETS, frameCadenceMs: 150 })
const server = await startWebServer(host, { NOTIFS_PATH: notifsPath })

console.log(`VISUAL_BASE=${server.base}`)
console.log("Ctrl+C to stop")

process.on("SIGINT", () => {
  server.stop()
  host.stop?.()
  process.exit(0)
})
