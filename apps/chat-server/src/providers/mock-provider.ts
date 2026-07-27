// In-memory MockProvider (PSN-93, Workstream B). Implements ChatProvider off deterministic
// fixtures so the sweep/routes can be tested with no live Teams tab. It also backs the standalone
// mock-upstream harness (test/mock-upstream.mjs) that TeamsProvider is tested against, so both the
// provider seam and the HTTP mapping are covered by the same fixture data.

import type {
  ChatConversation,
  ChatMessage,
  ChatProfile,
  ChatService,
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
const THIRD = "8:orgid:third-oid"

// Clock anchor, sampled ONCE at module load. Message ids stay fixed literals (tests pin them) while
// timestamps are relative to boot, so relative-time UI ("5m ago") is realistic without any drift
// inside a run — ordering, paging and cursors are identical every time.
const T0 = Date.now()
/** `n` minutes before boot, in epoch ms. */
const ago = (min: number): number => T0 - min * 60_000

/** A real, decodable 96×96 PNG for `avatar()` and `media()`. It has to actually decode: the profile
 *  dialog keeps its avatar button disabled until the image fires `load`, so a truncated stub made
 *  the profile→lightbox layering impossible to exercise on the mock stack. */
const PLACEHOLDER_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAAjklEQVR42u3QMQ0AAAgDsDlECd6RgANOriZV0FQPhygQJEiQIEGCBAlCkCBBggQJEoQgQYIECRIkSJAgBAkSJEiQIEGCBCFIkCBBggQJEoQgQYIECRIkSBCCBAkSJEiQIEGCECRIkCBBggQJQpAgQYIECRIkCEGCBAkSJEiQIEEIEiRIkCBBggQhSJCgPwvrXzOF2HYC0wAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
)

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
        lastMessageTs: ago(2880),
        lastMessagePreview: "note to self",
        lastMessageFromMe: true,
        readTs: ago(2880),
      }),
      messages: [
        msg({ id: "1000", ts: ago(2880), body: "note to self", senderId: SELF, self: true }),
      ],
    },
    {
      conv: conv({
        id: "19:oneonone@unq.gbl.spaces",
        kind: "oneOnOne",
        title: "Other Person",
        avatarUserId: "other-oid",
        lastMessageId: "2002",
        lastMessageTs: ago(90),
        lastMessagePreview: "hi there",
        readTs: ago(91),
      }),
      messages: [
        msg({
          id: "2001",
          ts: ago(91),
          body: "hello",
          senderId: SELF,
          senderName: "You",
          self: true,
        }),
        msg({
          id: "2002",
          ts: ago(90),
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
        lastMessageTs: ago(240),
        lastMessagePreview: "shipped",
        readTs: ago(240),
      }),
      messages: [
        msg({
          id: "3001",
          ts: ago(243),
          body: "kickoff",
          senderId: OTHER,
          senderName: "Other Person",
        }),
        msg({
          id: "3002",
          ts: ago(242),
          body: "on it",
          senderId: SELF,
          senderName: "You",
          self: true,
        }),
        msg({
          id: "3003",
          ts: ago(241),
          body: "reviewing",
          senderId: OTHER,
          senderName: "Other Person",
        }),
        msg({
          id: "3004",
          ts: ago(240),
          body: "shipped",
          senderId: SELF,
          senderName: "You",
          self: true,
        }),
      ],
    },
    ...richSeed(),
  ]
}

// ---------------------------------------------------------------------------
// Rich fixtures (PSN-105 I). The three seeds above are pinned by unit tests, so every state the
// chat UI can render lives here instead: links, reactions, an edit, a tombstone, a mention, an
// attachment, a system line, an unread row, and a long thread that actually pages.
// ---------------------------------------------------------------------------

/** A conversation whose local prefs the mock stack seeds at boot — the provider has no say in
 *  mute/rename (they are BFF-local), so index.ts writes these through `store.setPrefs`. */
export const MOCK_PREFS: { convId: string; patch: Record<string, unknown> }[] = [
  { convId: "19:muted@unq.gbl.spaces", patch: { muted: true } },
  { convId: "19:renamed@thread.v2", patch: { customTitle: "Renamed by me", folder: "Work" } },
]

/** The rich conversation whose thread pages — id kept stable so scripts can address it. */
export const LONG_CONV_ID = "19:longthread@thread.v2"

function longThread(): ChatMessage[] {
  // 30 messages so the FE's load-older path fires several times against HISTORY_PAGE.
  return Array.from({ length: 30 }, (_, i) =>
    msg({
      id: `7${String(i + 1).padStart(3, "0")}`,
      ts: ago(600 - i * 5),
      body: `Release train update #${i + 1}`,
      senderId: i % 3 === 0 ? SELF : i % 3 === 1 ? OTHER : THIRD,
      senderName: i % 3 === 0 ? "You" : i % 3 === 1 ? "Other Person" : "Third Person",
      self: i % 3 === 0,
    }),
  )
}

function richSeed(): Fixture[] {
  return [
    {
      // Everything a message bubble can render, in one unread group thread.
      conv: conv({
        id: "19:rich@thread.v2",
        kind: "group",
        topic: "Design review",
        title: "Design review",
        memberIds: ["other-oid", "third-oid"],
        lastMessageId: "6008",
        lastMessageTs: ago(3),
        lastMessagePreview: "and one more thing",
        readTs: ago(30),
      }),
      messages: [
        msg({
          id: "6001",
          ts: ago(30),
          kind: "system",
          body: "Other Person added Third Person to the chat",
        }),
        msg({
          id: "6002",
          ts: ago(28),
          body: 'Ticket is <a href="https://example.atlassian.net/browse/PSN-105">https://example.atlassian.net/browse/PSN-105</a> — please look before standup.',
          senderId: OTHER,
          senderName: "Other Person",
          reactions: [
            { key: "like", emoji: "👍", count: 2, mine: true, reactorNames: ["Third Person"] },
            { key: "heart", emoji: "❤️", count: 1, mine: false, reactorNames: ["Third Person"] },
          ],
        }),
        msg({
          id: "6003",
          ts: ago(26),
          body: 'PR up: <a href="https://dev.azure.com/example/Proj/_git/repo/pullrequest/4213">https://dev.azure.com/example/Proj/_git/repo/pullrequest/4213</a>',
          senderId: THIRD,
          senderName: "Third Person",
        }),
        msg({
          id: "6004",
          ts: ago(24),
          body: 'And the long one: <a href="https://example.com/a/very/long/path/that/should/be/elided/because/it/never/fits/on/one/line?q=1&ref=chat">https://example.com/a/very/long/path/that/should/be/elided/because/it/never/fits/on/one/line?q=1&amp;ref=chat</a>',
          senderId: THIRD,
          senderName: "Third Person",
        }),
        msg({
          id: "6005",
          ts: ago(20),
          body: "Looks good after the third pass",
          senderId: SELF,
          senderName: "You",
          self: true,
          edited: true,
          editTs: ago(18),
        }),
        msg({
          id: "6006",
          ts: ago(15),
          body: "",
          senderId: SELF,
          senderName: "You",
          self: true,
          deleted: true,
        }),
        msg({
          id: "6007",
          ts: ago(8),
          body: '<span class="mention">@You</span> can you sign this off today?',
          senderId: OTHER,
          senderName: "Other Person",
          mentionsMe: true,
          attachments: [
            {
              kind: "file",
              name: "design-review.pdf",
              type: "pdf",
              url: "https://example.sharepoint.com/personal/x/design-review.pdf",
            },
          ],
        }),
        msg({
          id: "6008",
          ts: ago(3),
          body: "and one more thing",
          senderId: OTHER,
          senderName: "Other Person",
        }),
      ],
    },
    {
      // Unread 1:1 that the mock stack mutes at boot — the row must stay quiet, no push.
      conv: conv({
        id: "19:muted@unq.gbl.spaces",
        kind: "oneOnOne",
        title: "Noisy Bot",
        avatarUserId: "third-oid",
        lastMessageId: "6101",
        lastMessageTs: ago(12),
        lastMessagePreview: "build #4213 finished",
        readTs: ago(400),
        muted: true,
      }),
      messages: [
        msg({
          id: "6101",
          ts: ago(12),
          body: "build #4213 finished",
          senderId: THIRD,
          senderName: "Noisy Bot",
        }),
      ],
    },
    {
      // Locally renamed + filed into a folder at boot.
      conv: conv({
        id: "19:renamed@thread.v2",
        kind: "group",
        topic: "Original Topic",
        title: "Original Topic",
        memberIds: ["other-oid"],
        lastMessageId: "6201",
        lastMessageTs: ago(50),
        lastMessagePreview: "renamed locally, original stays as the subtitle",
        readTs: ago(50),
      }),
      messages: [
        msg({
          id: "6201",
          ts: ago(50),
          body: "renamed locally, original stays as the subtitle",
          senderId: OTHER,
          senderName: "Other Person",
        }),
      ],
    },
    {
      conv: conv({
        id: LONG_CONV_ID,
        kind: "group",
        topic: "Release train",
        title: "Release train",
        memberIds: ["other-oid", "third-oid"],
        lastMessageId: "7030",
        lastMessageTs: ago(455),
        lastMessagePreview: "Release train update #30",
        readTs: ago(455),
      }),
      messages: longThread(),
    },
  ]
}

// Tiny by default so the paging tests stay cheap; the local mock stack raises it (CHAT_MOCK_PAGE)
// so a thread opens looking like a real one instead of two bubbles.
const HISTORY_PAGE = Number(process.env.CHAT_MOCK_PAGE) || 2

export class MockProvider implements ChatProvider {
  readonly service: ChatService
  private fixtures: Fixture[]
  private nextTs: number

  // `service` defaults to "teams" (the harness/tests that stamp Teams shapes), overridable so it
  // can register under a "mock" service id for hermetic e2e without a Teams tab.
  constructor(service: ChatService = SERVICE) {
    this.service = service
    this.fixtures = seed().map((f) => ({
      conv: { ...f.conv, service },
      messages: f.messages.map((m) => ({ ...m, service })),
    }))
    // Past every fixture ts AND past the wall clock, so a send/inject always sorts newest.
    const newest = Math.max(T0, ...this.fixtures.flatMap((f) => f.messages.map((m) => m.ts)))
    this.nextTs = newest + 1
  }

  private find(convId: string): Fixture {
    const f = this.fixtures.find((x) => x.conv.id === convId)
    if (!f) throw new ProviderError("not_found", 404)
    return f
  }

  /** Advance a conversation's message version — the sweep's change gate. Without this a mutation is
   *  invisible to the list lane and never fans out as a WS delta. */
  private bump(f: Fixture): void {
    f.conv = { ...f.conv, lastMessageVersion: f.conv.lastMessageVersion + 1 }
  }

  /**
   * Simulate INBOUND traffic (PSN-105 I): append a message from someone else and bump the version,
   * so the sweep's list lane sees a genuinely new last message and drives the full delivery path
   * (WS delta → FE, web push, Electron notification). The one thing a fixture set can't do on its
   * own, and the only local way to test "does it arrive while the window is minimised?".
   */
  inject(convId?: string, text?: string): { convId: string; msgId: string; ts: number } {
    const f = convId ? this.find(convId) : this.fixtures[this.fixtures.length - 1]
    const ts = this.nextTs++
    const id = String(ts)
    const body = text || `mock inbound at ${new Date(ts).toLocaleTimeString()}`
    f.messages.push(msg({ id, ts, body, senderId: OTHER, senderName: "Other Person" }))
    f.conv = {
      ...f.conv,
      lastMessageId: id,
      lastMessageTs: ts,
      lastMessagePreview: body,
      lastMessageFromMe: false,
    }
    this.bump(f)
    return { convId: f.conv.id, msgId: id, ts }
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
    this.bump(f)
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
    this.bump(f)
  }

  async edit(convId: string, msgId: string, text: string): Promise<void> {
    const f = this.find(convId)
    const m = f.messages.find((x) => x.id === msgId)
    if (!m) throw new ProviderError("not_found", 404)
    m.body = text
    m.edited = true
    m.editTs = Date.now()
    this.bump(f)
  }

  async delete(convId: string, msgId: string): Promise<void> {
    const f = this.find(convId)
    const m = f.messages.find((x) => x.id === msgId)
    if (!m) throw new ProviderError("not_found", 404)
    m.deleted = true
    m.body = ""
    this.bump(f)
  }

  // Mirrors the real service: the read watermark only moves forward, and a read clears any
  // mark-unread bookmark.
  async markRead(convId: string, _msgId: string, ts: number): Promise<void> {
    const f = this.find(convId)
    f.conv = { ...f.conv, readTs: Math.max(f.conv.readTs, ts), unreadBookmarkTs: 0 }
  }

  async markUnread(convId: string, ts: number): Promise<void> {
    const f = this.find(convId)
    f.conv = { ...f.conv, unreadBookmarkTs: Math.max(1, ts) }
  }

  async roster(convId: string): Promise<RosterMember[]> {
    this.find(convId)
    return [
      { id: SELF, name: "You", self: true },
      { id: OTHER, name: "Other Person" },
      { id: THIRD, name: "Third Person" },
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

  // A DECODABLE 96×96 PNG, not a 4-byte header. The avatar button stays disabled until the image
  // actually loads, so a truncated stub left the profile→lightbox layering untestable locally.
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
    return { contentType: "image/png", body: PLACEHOLDER_PNG }
  }

  async media(_url: string): Promise<MediaBytes> {
    return { contentType: "image/png", body: PLACEHOLDER_PNG }
  }
}
