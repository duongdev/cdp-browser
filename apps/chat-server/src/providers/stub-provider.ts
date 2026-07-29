// A test-only ChatProvider stub factory (PSN-93, Workstream D). The sweep + backfill tests only
// touch `service` + `listConversations` + `fetchHistory`; every other method throws "unused". A
// caller overrides just the methods it exercises, so a test never hand-writes the full 15-method
// interface. Not shipped — imported only from *.test.ts.

import type { ChatProvider } from "./provider.ts"

const throwUnused = () => {
  throw new Error("unused")
}

/** Build a ChatProvider whose unused methods throw. `over` supplies the methods a test drives. */
export function stubProvider(
  over: Partial<ChatProvider> & Pick<ChatProvider, "service">,
): ChatProvider {
  const base: ChatProvider = {
    service: over.service,
    listConversations: async () => ({ conversations: [], cursor: null }),
    fetchHistory: async () => ({ messages: [], cursor: null }),
    sendReply: throwUnused as ChatProvider["sendReply"],
    react: async () => {},
    edit: async () => {},
    delete: async () => {},
    markRead: async () => {},
    markUnread: async () => {},
    roster: async () => [],
    uploadImage: throwUnused as ChatProvider["uploadImage"],
    uploadImages: throwUnused as ChatProvider["uploadImages"],
    uploadFile: throwUnused as ChatProvider["uploadFile"],
    profile: throwUnused as ChatProvider["profile"],
    avatar: async () => ({ miss: true as const }),
    media: throwUnused as ChatProvider["media"],
    searchMessages: async () => ({ rows: [], cursor: null, total: 0 }),
  }
  return { ...base, ...over }
}
