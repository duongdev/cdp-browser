// Teams web push, owned by the BFF (PSN-93, Workstream G, decision 8). The sweep is the driver: a
// genuinely new inbound message on the list lane fires a push to every stored sub — with ZERO FE
// clients open (that is the point of the BFF). Exactly ONE Teams push sender now lives here; the old
// server.mjs `teamsNotifySweep` send is disabled so a message can't push twice.
//
// Split: `shouldPush` is the pure gate (self-skip, read-watermark skip, cold-start skip, mute /
// notifyOnMention / mentionsMe) so it unit-tests without a store or webpush; `createPushSender` does
// the I/O (VAPID send, 410-prune) behind DI so tests spy the send without hitting a push service.

import { createRequire } from "node:module"
import type BetterSqlite3 from "better-sqlite3"
import type { ChatConversation } from "./contract.ts"
import * as store from "./store.ts"

const require = createRequire(import.meta.url)
const { pushSendOptions } = require("../../../core/push-send-options.js") as {
  pushSendOptions: () => { urgency: string; TTL: number }
}
const { isMutedNow } = require("../../../core/teams-store.js") as {
  isMutedNow: (
    prefs: { muted: boolean; mutedUntil?: number | null } | null,
    now?: number,
  ) => boolean
}

type Db = BetterSqlite3.Database

/** The SW payload contract (chat/public/sw.js + src/lib/push-notification.ts). Field names are load-
 *  bearing — the SW reads `title`/`body`/`convId`/`tag`, and the click handler deep-routes on `convId`
 *  to /chat/c/{convId}. `type:"teams"` mirrors what buildTeamsPushPayload sent so nothing regresses. */
export interface ChatPushPayload {
  type: string
  title: string
  body: string
  convId: string
  msgId: string | null
  ts: number | null
  tag: string
}

/** Whether a changed conversation warrants a push. Pure — the caller supplies the row + its local
 *  prefs + whether the last message @mentions the viewer (looked up from the store).
 *
 *  - `hadPrior=false` → cold-start seed, never push (mirrors teamsNotifySweep's watermark seeding:
 *    the whole list looks "new" on first sight).
 *  - own send (`lastMessageFromMe`) → never push.
 *  - already read (`lastMessageTs <= readTs`) → nothing new.
 *  - muted-now → silent, UNLESS notifyOnMention && the message mentions the viewer. */
export function shouldPush(
  conv: Pick<ChatConversation, "lastMessageFromMe" | "lastMessageTs" | "readTs">,
  hadPrior: boolean,
  prefs: { muted: boolean; mutedUntil?: number | null; notifyOnMention?: boolean } | null,
  mentionsMe: boolean,
  now: number = Date.now(),
): boolean {
  if (!hadPrior) return false
  if (conv.lastMessageFromMe) return false
  if ((conv.lastMessageTs ?? 0) <= (conv.readTs ?? 0)) return false
  if (isMutedNow(prefs, now)) return !!(prefs?.notifyOnMention && mentionsMe)
  return true
}

/** Title for a push. A group with a topic → "{sender} · {topic}"; else the conversation title
 *  (resolved member name for a DM) or the sender. Matches buildTeamsPushPayload's shape. */
export function pushTitle(conv: ChatConversation, senderName: string | null): string {
  const sender = senderName || conv.title || "Teams"
  if (conv.kind === "group" && conv.topic?.trim()) return `${sender} · ${conv.topic}`
  return conv.title || sender
}

/** The webpush surface this module needs — the real `web-push` lib satisfies it; tests pass a spy.
 *  `sub`/`options` are loose (the lib's own types are stricter than our DI shape) so both the real
 *  library and a hand-rolled test fake assign here. */
export interface WebPush {
  // biome-ignore lint/suspicious/noExplicitAny: DI seam accepting both the real web-push + test fakes
  sendNotification(sub: any, payload?: any, options?: any): Promise<unknown>
}

export interface PushSenderDeps {
  db: Db
  service: string
  webpush: WebPush
  now?: () => number
}

export interface PushSender {
  /** Send `payload` to every stored sub for the service; prune subs that come back 404/410. Resolves
   *  the count sent (best-effort — a send error never throws, so the sweep can't break). */
  send(payload: ChatPushPayload): Promise<number>
}

export function createPushSender(deps: PushSenderDeps): PushSender {
  const { db, service, webpush } = deps
  return {
    async send(payload) {
      const subs = store.listPushSubs(db, service)
      if (subs.length === 0) return 0
      const data = JSON.stringify(payload)
      const dead: string[] = []
      let sent = 0
      await Promise.all(
        subs.map(async (s) => {
          try {
            await webpush.sendNotification(s.subscription, data, pushSendOptions())
            sent++
          } catch (e) {
            const code = (e as { statusCode?: number })?.statusCode
            if (code === 404 || code === 410) dead.push(s.endpoint)
            else console.error("[chat-push] send failed:", code, (e as Error)?.message)
          }
        }),
      )
      for (const endpoint of dead) store.deletePushSub(db, service, endpoint)
      return sent
    },
  }
}

/** Build the SW payload for a conversation's new last message. `mentionsMe` is looked up by the
 *  sweep; kept out of here so this stays a pure shaper. */
export function buildPushPayload(
  conv: ChatConversation,
  senderName: string | null,
): ChatPushPayload {
  return {
    type: "teams",
    title: pushTitle(conv, senderName),
    body: conv.lastMessagePreview || "",
    convId: conv.id,
    msgId: conv.lastMessageId,
    ts: conv.lastMessageTs,
    tag: conv.id,
  }
}
