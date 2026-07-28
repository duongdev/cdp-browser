// TeamsProvider (PSN-93, Workstream B): a ChatProvider that reaches Teams THROUGH server.mjs's
// `/internal/teams/*` API. server.mjs owns the CDP side-channel; this is just an HTTP client of it,
// mapping the Teams-native response shapes into the generic contract types (stamp `service:"teams"`,
// RosterMember.mri→id, MentionRef.mri→id, clientmessageid→clientMessageId).
//
// Base URL from TEAMS_UPSTREAM_URL (default http://localhost:7800), secret from CHAT_INTERNAL_SECRET
// (default `dev-internal-secret`, matching server.mjs's dev value). An upstream `{ error: code }`
// becomes a thrown ProviderError the routes surface unchanged.

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
  ProviderSearchHit,
  ProviderSearchPage,
  UploadImage,
  UploadResult,
} from "./provider.ts"
import { ProviderError } from "./provider.ts"

const SERVICE: ChatService = "teams"

/** The Teams-native conversation/message rows are ALREADY nearly the contract shape (both were lifted
 *  from the same source) — the only server-side gap is the missing `service` discriminator, which the
 *  contract requires and the internal route omits. Stamp it here. */
type TeamsConvRow = Omit<ChatConversation, "service">
type TeamsMsgRow = Omit<ChatMessage, "service">

export interface TeamsProviderOptions {
  baseUrl?: string
  secret?: string
  fetchImpl?: typeof fetch
}

export class TeamsProvider implements ChatProvider {
  readonly service = SERVICE
  private baseUrl: string
  private secret: string
  private fetchImpl: typeof fetch

  constructor(opts: TeamsProviderOptions = {}) {
    this.baseUrl = (
      opts.baseUrl ??
      process.env.TEAMS_UPSTREAM_URL ??
      "http://localhost:7800"
    ).replace(/\/$/, "")
    this.secret = opts.secret ?? process.env.CHAT_INTERNAL_SECRET ?? "dev-internal-secret"
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  /** POST an internal op, decode JSON, throw ProviderError on an upstream `{ error }` or non-2xx. */
  private async call<T>(op: string, body: unknown): Promise<T> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.baseUrl}/internal/teams/${op}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": this.secret },
        body: JSON.stringify(body ?? {}),
      })
    } catch {
      throw new ProviderError("upstream_unreachable", 502)
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string } & Record<
      string,
      unknown
    >
    if (res.status === 403) throw new ProviderError(data.error || "forbidden", 403)
    if (!res.ok || data.error)
      throw new ProviderError(data.error || `http_${res.status}`, res.status)
    return data as T
  }

  private mapConv = (c: TeamsConvRow): ChatConversation => ({ ...c, service: SERVICE })
  private mapMsg = (m: TeamsMsgRow): ChatMessage => ({ ...m, service: SERVICE })

  async listConversations(cursor?: string | null): Promise<ConversationsPage> {
    const out = await this.call<{ conversations?: TeamsConvRow[]; cursor?: string | null }>(
      "conversations",
      cursor ? { cursor } : {},
    )
    return {
      conversations: (out.conversations ?? []).map(this.mapConv),
      cursor: out.cursor ?? null,
    }
  }

  async fetchHistory(convId: string, cursor?: string | null, poll?: boolean): Promise<HistoryPage> {
    const out = await this.call<{ messages?: TeamsMsgRow[]; cursor?: string | null }>("history", {
      convId,
      ...(cursor ? { cursor } : {}),
      ...(poll ? { poll: true } : {}),
    })
    return { messages: (out.messages ?? []).map(this.mapMsg), cursor: out.cursor ?? null }
  }

  async sendReply(
    convId: string,
    text: string,
    opts?: { html?: string | null; quotes?: ReplyRef[]; mentions?: MentionRef[] },
  ): Promise<SendResult> {
    // The internal reply route's mention shape is Teams-native (`mri`); the contract's MentionRef
    // carries `id`. Map id→mri on the way out.
    const mentions = (opts?.mentions ?? []).map((m) => ({
      itemid: m.itemid,
      mri: m.id,
      displayName: m.displayName,
    }))
    const out = await this.call<{ ts?: string; clientmessageid?: string }>("reply", {
      convId,
      text,
      html: opts?.html ?? null,
      quotes: opts?.quotes ?? [],
      mentions,
    })
    return { ok: true, ts: String(out.ts ?? ""), clientMessageId: out.clientmessageid ?? "" }
  }

  async react(convId: string, msgId: string, key: string, remove: boolean): Promise<void> {
    await this.call("react", { convId, msgId, key, remove })
  }

  async edit(convId: string, msgId: string, text: string): Promise<void> {
    await this.call("edit", { convId, msgId, text })
  }

  async delete(convId: string, msgId: string): Promise<void> {
    await this.call("delete", { convId, msgId })
  }

  async markRead(convId: string, msgId: string, ts: number): Promise<void> {
    await this.call("mark-read", { convId, msgId, ts })
  }

  async markUnread(convId: string, ts: number): Promise<void> {
    await this.call("mark-unread", { convId, ts })
  }

  async roster(convId: string): Promise<RosterMember[]> {
    const out = await this.call<{ members?: { mri: string; name: string; self?: boolean }[] }>(
      "roster",
      { convId },
    )
    // RosterMember: Teams-native `mri` → contract `id`.
    return (out.members ?? []).map((m) => ({
      id: m.mri,
      name: m.name,
      ...(m.self ? { self: true } : {}),
    }))
  }

  async uploadImage(convId: string, image: UploadImage, text?: string): Promise<UploadResult> {
    const out = await this.call<{ msgId?: string }>("upload-image", { convId, ...image, text })
    return { ok: true, msgId: String(out.msgId ?? "") }
  }

  async uploadImages(convId: string, images: UploadImage[], text?: string): Promise<UploadResult> {
    const out = await this.call<{ msgId?: string }>("upload-images", { convId, images, text })
    return { ok: true, msgId: String(out.msgId ?? "") }
  }

  async uploadFile(
    convId: string,
    file: { filename: string; base64: string; contentType?: string },
    text?: string,
  ): Promise<UploadResult> {
    const out = await this.call<{ msgId?: string }>("upload-file", { convId, ...file, text })
    return { ok: true, msgId: String(out.msgId ?? "") }
  }

  async profile(userId: string): Promise<ChatProfile> {
    const out = await this.call<{ profile?: ChatProfile }>("profile", { userId })
    if (!out.profile) throw new ProviderError("not_found", 404)
    return out.profile
  }

  async avatar(userId: string, size?: string): Promise<AvatarResult> {
    const out = await this.call<{ miss?: boolean; ct?: string; base64?: string }>("avatar", {
      userId,
      size,
    })
    if (out.miss) return { miss: true }
    return { contentType: out.ct || "image/jpeg", body: decodeBase64(out.base64 || "") }
  }

  async media(url: string): Promise<MediaBytes> {
    const out = await this.call<{ ct?: string; base64?: string }>("media", { url })
    return {
      contentType: out.ct || "application/octet-stream",
      body: decodeBase64(out.base64 || ""),
    }
  }

  /**
   * Substrate search (PSN-115 WS-A). Cursor is a string-encoded `from` offset (the substrate API
   * uses from/size pagination; a real cursor token isn't exposed today). `sort` is accepted but not
   * forwarded yet — the live-verified body has no sort field; it'll wire onto the request body when
   * we adopt SortOrderSource. The route returns `{hits,total}` with no next-cursor, so this always
   * reports `cursor:null` (single page per call).
   */
  async searchMessages(
    query: string,
    opts?: { sort?: "relevance" | "recent"; cursor?: string | null },
  ): Promise<ProviderSearchPage> {
    void opts?.sort // reserved for when the body grows a SortOrderSource field
    const from = Number(opts?.cursor) || 0
    const out = await this.call<{ hits?: ProviderSearchHit[]; total?: number }>("search", {
      query,
      from,
      size: 25,
    })
    return {
      rows: (out.hits ?? []).map((h) => ({ ...h })),
      cursor: null,
      total: Number(out.total ?? out.hits?.length ?? 0),
    }
  }
}

function decodeBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"))
}
