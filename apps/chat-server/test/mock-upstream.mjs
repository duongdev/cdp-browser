// Standalone mock upstream (PSN-93, Workstream B) — a tiny HTTP server that speaks the
// `/internal/teams/*` contract server.mjs exposes, backed by the same MockProvider fixtures. Lets
// teams-provider.test.ts exercise TeamsProvider end-to-end over real HTTP: it emits the Teams-native
// wire shape (no `service`; roster `mri`; reply `clientmessageid`; avatar/media base64) so the
// provider's field mapping is genuinely tested, and enforces the shared-secret guard (403 without it).
//
// Node ESM, no deps. `startMockUpstream()` → { url, secret, close } (port 0 = OS-assigned).

import http from "node:http"
import { MockProvider } from "../src/providers/mock-provider.ts"

const DEFAULT_SECRET = "test-internal-secret"

function readBody(req) {
  return new Promise((resolve) => {
    let b = ""
    req.on("data", (c) => {
      b += c
    })
    req.on("end", () => {
      try {
        resolve(b ? JSON.parse(b) : {})
      } catch {
        resolve({})
      }
    })
  })
}

// Strip the contract's `service` back to the Teams-native row the internal route would emit.
function stripService({ service, ...rest }) {
  return rest
}

/**
 * @param {{ secret?: string, provider?: import("../src/providers/mock-provider.ts").MockProvider }} [opts]
 */
export async function startMockUpstream(opts = {}) {
  const secret = opts.secret ?? DEFAULT_SECRET
  const provider = opts.provider ?? new MockProvider()

  const server = http.createServer(async (req, res) => {
    const send = (data, code = 200) =>
      res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(data))

    if (!req.url?.startsWith("/internal/teams/")) return send({ error: "not_found" }, 404)
    // Shared-secret guard — the whole point of the internal namespace.
    if (req.headers["x-internal-secret"] !== secret) return send({ error: "forbidden" }, 403)

    const op = req.url.slice("/internal/teams/".length)
    const b = await readBody(req)
    try {
      switch (op) {
        case "conversations": {
          const page = await provider.listConversations(b.cursor ?? null)
          return send({ conversations: page.conversations.map(stripService), cursor: page.cursor })
        }
        case "history": {
          const page = await provider.fetchHistory(b.convId, b.cursor ?? null, !!b.poll)
          return send({ messages: page.messages.map(stripService), cursor: page.cursor })
        }
        case "reply": {
          // The internal reply route carries Teams-native `mri` mentions; assert the provider sent them.
          const mentions = (b.mentions ?? []).map((m) => ({
            id: m.mri,
            itemid: m.itemid,
            displayName: m.displayName,
          }))
          const r = await provider.sendReply(b.convId, b.text, { html: b.html ?? null, mentions })
          // Emit the Teams-native `clientmessageid` (lowercase) so the mapping is tested.
          return send({ ok: true, ts: r.ts, clientmessageid: r.clientMessageId })
        }
        case "react":
          await provider.react(b.convId, b.msgId, b.key, !!b.remove)
          return send({ ok: true })
        case "edit":
          await provider.edit(b.convId, b.msgId, b.text)
          return send({ ok: true })
        case "delete":
          await provider.delete(b.convId, b.msgId)
          return send({ ok: true })
        case "mark-read":
          await provider.markRead(b.convId, b.msgId, b.ts)
          return send({ ok: true })
        case "roster": {
          const members = await provider.roster(b.convId)
          // Emit Teams-native `mri` so the provider's mri→id mapping is exercised.
          return send({
            members: members.map((m) => ({
              mri: m.id,
              name: m.name,
              ...(m.self ? { self: true } : {}),
            })),
          })
        }
        case "upload-image": {
          const r = await provider.uploadImage(b.convId, b, b.text)
          return send({ ok: true, msgId: r.msgId })
        }
        case "upload-images": {
          const r = await provider.uploadImages(b.convId, b.images ?? [], b.text)
          return send({ ok: true, msgId: r.msgId })
        }
        case "upload-file": {
          const r = await provider.uploadFile(b.convId, b, b.text)
          return send({ ok: true, msgId: r.msgId })
        }
        case "profile": {
          const profile = await provider.profile(b.userId)
          return send({ profile })
        }
        case "avatar": {
          const a = await provider.avatar(b.userId)
          if ("miss" in a) return send({ miss: true })
          return send({ ct: a.contentType, base64: Buffer.from(a.body).toString("base64") })
        }
        case "media": {
          const m = await provider.media(b.url)
          return send({ ct: m.contentType, base64: Buffer.from(m.body).toString("base64") })
        }
        case "search": {
          const page = await provider.searchMessages(b.query ?? "", {
            cursor: b.cursor ?? null,
          })
          return send({ hits: page.rows, total: page.total })
        }
        default:
          return send({ error: "not_found" }, 404)
      }
    } catch (e) {
      return send({ error: e?.code || "server_error" }, e?.status || 502)
    }
  })

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    secret,
    provider,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
