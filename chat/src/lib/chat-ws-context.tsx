// React binding for the chat BFF WebSocket (PSN-93, Workstream E). One `createChatWs` connection for
// the app's lifetime, a fan-out bus so the conversation list + each thread pane subscribe to just the
// frame kinds they need, focus steering driven by the open thread, and the connection status for the
// "Reconnecting…" banner.
//
// The list + panes keep owning their own state — they apply each frame through the SAME
// merge reducers they already use (mergeConversations / mergeMessages / read overlays). This bus only
// delivers frames; it holds no domain state.

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { type ChatWsClient, type ChatWsFrame, type ChatWsStatus, createChatWs } from "./chat-ws"

type FrameHandler = (frame: ChatWsFrame) => void

interface ChatWsContextValue {
  /** Subscribe to every server frame; returns an unsubscribe. The subscriber filters by kind/convId. */
  subscribe(handler: FrameHandler): () => void
  /** Steer the server fast-sweep to the open thread (null = none). */
  setFocus(convId: string | null): void
  /** Ask a connected producer for reply suggestions (ADR-0027). Returns false when the socket is
   *  not open — the caller shows "not connected" instead of spinning on a request never sent. */
  requestSuggestions(convId: string, regenerate: boolean): boolean
  /** online ⇄ reconnecting — drives the banner + the poll fallback gate. */
  status: ChatWsStatus
}

const ChatWsCtx = createContext<ChatWsContextValue | null>(null)

export function ChatWsProvider({ children }: { children: ReactNode }) {
  const handlers = useRef(new Set<FrameHandler>())
  const [status, setStatus] = useState<ChatWsStatus>("reconnecting")
  const clientRef = useRef<ChatWsClient | null>(null)

  useEffect(() => {
    const client = createChatWs({
      onFrame: (frame) => {
        for (const h of handlers.current) h(frame)
      },
      onStatus: setStatus,
    })
    clientRef.current = client
    return () => {
      client.close()
      clientRef.current = null
    }
  }, [])

  const value = useMemo<ChatWsContextValue>(
    () => ({
      subscribe(handler) {
        handlers.current.add(handler)
        return () => handlers.current.delete(handler)
      },
      setFocus(convId) {
        clientRef.current?.setFocus(convId)
      },
      requestSuggestions(convId, regenerate) {
        return clientRef.current?.requestSuggestions(convId, regenerate) ?? false
      },
      status,
    }),
    [status],
  )

  return <ChatWsCtx.Provider value={value}>{children}</ChatWsCtx.Provider>
}

/** Subscribe to WS frames for the lifetime of the calling component. `handler` is held in a ref so a
 *  fresh closure each render doesn't churn the subscription. Returns the live connection status. */
export function useChatWsFrames(handler: FrameHandler): ChatWsStatus {
  const ctx = useContext(ChatWsCtx)
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  useEffect(() => {
    if (!ctx) return
    return ctx.subscribe((frame) => handlerRef.current(frame))
  }, [ctx])
  return ctx?.status ?? "online"
}

/** Steer the server fast-sweep + read the connection status without subscribing to frames. */
export function useChatWs(): {
  setFocus(convId: string | null): void
  requestSuggestions(convId: string, regenerate: boolean): boolean
  status: ChatWsStatus
} {
  const ctx = useContext(ChatWsCtx)
  return {
    setFocus: (convId) => ctx?.setFocus(convId),
    // No provider → false, which the caller renders as "not connected". Silently reporting success
    // would leave the user waiting for a batch nothing is producing.
    requestSuggestions: (convId, regenerate) =>
      ctx?.requestSuggestions(convId, regenerate) ?? false,
    status: ctx?.status ?? "online",
  }
}
