// In-memory MockProvider (PSN-93, Workstream B). Implements ChatProvider off deterministic
// fixtures so the sweep/routes can be tested with no live Teams tab. It also backs the standalone
// mock-upstream harness (test/mock-upstream.mjs) that TeamsProvider is tested against, so both the
// provider seam and the HTTP mapping are covered by the same fixture data.

import type {
  ChatConversation,
  ChatMessage,
  ChatProfile,
  ConversationsPage,
  HistoryPage,
  MentionRef,
  ReplyRef,
  RosterMember,
  SendResult,
} from "../contract.ts"
import type {
  AvatarResult,
  ChatProvider,
  MediaBytes,
  UploadImage,
  UploadResult,
} from "./provider.ts"
import { ProviderError } from "./provider.ts"

const SERVICE = "teams" as const
const SELF = "8:orgid:self-oid"
const OTHER = "8:orgid:other-oid"

/** A conversation + its messages (newest last). History is paged 2-per-page for paging tests. */
interface Fixture {
  conv: ChatConversation
  messages: ChatMessage[]
}

function conv(
  over: Partial<ChatConversation> & Pick<ChatConversation, "id" | "kind">,
): ChatConversation {
  return {
    service: SERVICE,
    topic: null,
    lastMessageId: null,
    lastMessageVersion: 0,
    lastMessageTs: null,
    lastMessagePreview: "",
    readTs: 0,
    lastMessageFromMe: false,
    unreadSticky: false,
    muted: false,
    ...over,
  }
}

function msg(over: Partial<ChatMessage> & Pick<ChatMessage, "id" | "ts" | "body">): ChatMessage {
  return { service: SERVICE, ...over }
}

/** The seed fixtures — a self chat, a 1:1, and a group with a paged history. Deterministic ids/ts. */
function seed(): Fixture[] {
  return [
    {
      conv: conv({
        id: "48:notes",
        kind: "self",
        title: "You (You)",
        lastMessageId: "1000",
        lastMessageTs: 1000,
        lastMessagePreview: "note to self",
        lastMessageFromMe: true,
        readTs: 1000,
      }),
      messages: [msg({ id: "1000", ts: 1000, body: "note to self", senderId: SELF, self: true })],
    },
    {
      conv: conv({
        id: "19:oneonone@unq.gbl.spaces",
        kind: "oneOnOne",
        title: "Other Person",
        avatarUserId: "other-oid",
        lastMessageId: "2002",
        lastMessageTs: 2002,
        lastMessagePreview: "hi there",
        readTs: 2001,
      }),
      messages: [
        msg({ id: "2001", ts: 2001, body: "hello", senderId: SELF, senderName: "You", self: true }),
        msg({
          id: "2002",
          ts: 2002,
          body: "hi there",
          senderId: OTHER,
          senderName: "Other Person",
        }),
      ],
    },
    {
      conv: conv({
        id: "19:group@thread.v2",
        kind: "group",
        topic: "Project X",
        title: "Project X",
        memberIds: ["other-oid", "third-oid"],
        lastMessageId: "3004",
        lastMessageTs: 3004,
        lastMessagePreview: "shipped",
        readTs: 3000,
      }),
      messages: [
        msg({ id: "3001", ts: 3001, body: "kickoff", senderId: OTHER, senderName: "Other Person" }),
        msg({ id: "3002", ts: 3002, body: "on it", senderId: SELF, senderName: "You", self: true }),
        msg({
          id: "3003",
          ts: 3003,
          body: "reviewing",
          senderId: OTHER,
          senderName: "Other Person",
        }),
        msg({
          id: "3004",
          ts: 3004,
          body: "shipped",
          senderId: SELF,
          senderName: "You",
          self: true,
        }),
      ],
    },
  ]
}

const HISTORY_PAGE = 2

export class MockProvider implements ChatProvider {
  readonly service = SERVICE
  private fixtures: Fixture[]
  private nextTs = 9000

  constructor() {
    this.fixtures = seed()
  }

  private find(convId: string): Fixture {
    const f = this.fixtures.find((x) => x.conv.id === convId)
    if (!f) throw new ProviderError("not_found", 404)
    return f
  }

  async listConversations(cursor?: string | null): Promise<ConversationsPage> {
    // Single page — the fixture set is small; cursor always ends.
    if (cursor) return { conversations: [], cursor: null }
    return { conversations: this.fixtures.map((f) => ({ ...f.conv })), cursor: null }
  }

  async fetchHistory(convId: string, cursor?: string | null): Promise<HistoryPage> {
    const all = this.find(convId).messages
    // Newest page first (cursor = the offset of already-returned newest items).
    const offset = cursor ? Number(cursor) : 0
    const end = all.length - offset
    const start = Math.max(0, end - HISTORY_PAGE)
    const page = all.slice(start, end).map((m) => ({ ...m }))
    const nextOffset = offset + page.length
    return { messages: page, cursor: nextOffset < all.length ? String(nextOffset) : null }
  }

  async sendReply(
    convId: string,
    text: string,
    opts?: { html?: string | null; quotes?: ReplyRef[]; mentions?: MentionRef[] },
  ): Promise<SendResult> {
    const f = this.find(convId)
    const ts = this.nextTs++
    const id = String(ts)
    f.messages.push(
      msg({ id, ts, body: opts?.html || text, senderId: SELF, senderName: "You", self: true }),
    )
    f.conv = {
      ...f.conv,
      lastMessageId: id,
      lastMessageTs: ts,
      lastMessagePreview: text,
      lastMessageFromMe: true,
    }
    return { ok: true, ts: id, clientMessageId: `cmid-${id}` }
  }

  async react(convId: string, msgId: string, key: string, remove: boolean): Promise<void> {
    const f = this.find(convId)
    const m = f.messages.find((x) => x.id === msgId)
    if (!m) throw new ProviderError("not_found", 404)
    const reactions = m.reactions ? [...m.reactions] : []
    const idx = reactions.findIndex((r) => r.key === key)
    if (remove) {
      if (idx >= 0) {
        const r = reactions[idx]
        if (r.count <= 1) reactions.splice(idx, 1)
        else reactions[idx] = { ...r, count: r.count - 1, mine: false }
      }
    } else if (idx >= 0)
      reactions[idx] = { ...reactions[idx], count: reactions[idx].count + 1, mine: true }
    else reactions.push({ key, emoji: "🙂", count: 1, mine: true })
    m.reactions = reactions.length ? reactions : undefined
  }

  async edit(convId: string, msgId: string, text: string): Promise<void> {
    const m = this.find(convId).messages.find((x) => x.id === msgId)
    if (!m) throw new ProviderError("not_found", 404)
    m.body = text
    m.edited = true
  }

  async delete(convId: string, msgId: string): Promise<void> {
    const m = this.find(convId).messages.find((x) => x.id === msgId)
    if (!m) throw new ProviderError("not_found", 404)
    m.deleted = true
    m.body = ""
  }

  async markRead(convId: string, _msgId: string, ts: number): Promise<void> {
    const f = this.find(convId)
    f.conv = { ...f.conv, readTs: Math.max(f.conv.readTs, ts) }
  }

  async roster(convId: string): Promise<RosterMember[]> {
    this.find(convId)
    return [
      { id: SELF, name: "You", self: true },
      { id: OTHER, name: "Other Person" },
    ]
  }

  async uploadImage(convId: string, _image: UploadImage, text?: string): Promise<UploadResult> {
    const r = await this.sendReply(convId, text || "[image]")
    return { ok: true, msgId: r.ts }
  }

  async uploadImages(convId: string, _images: UploadImage[], text?: string): Promise<UploadResult> {
    const r = await this.sendReply(convId, text || "[images]")
    return { ok: true, msgId: r.ts }
  }

  async uploadFile(
    convId: string,
    file: { filename: string; base64: string; contentType?: string },
    text?: string,
  ): Promise<UploadResult> {
    const r = await this.sendReply(convId, text || `[file] ${file.filename}`)
    return { ok: true, msgId: r.ts }
  }

  async profile(userId: string): Promise<ChatProfile> {
    return {
      displayName: userId === "self-oid" ? "You" : "Other Person",
      mail: `${userId}@example.com`,
      jobTitle: "Engineer",
      department: "R&D",
      officeLocation: "Remote",
      phones: [],
    }
  }

  async avatar(userId: string): Promise<AvatarResult> {
    if (userId === "no-photo-oid") return { miss: true }
    return { contentType: "image/png", body: new Uint8Array([137, 80, 78, 71]) }
  }

  async media(_url: string): Promise<MediaBytes> {
    return { contentType: "image/png", body: new Uint8Array([137, 80, 78, 71]) }
  }
}
