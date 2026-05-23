import { useRef } from "react"
import { createRemotePage, type RemotePage } from "@/lib/remote-page"

/**
 * The single Remote Page for the app's lifetime (see docs/adr/0001). It funnels over
 * `window.cdp`, whose active WebSocket the main process swaps on tab switch — so the
 * Remote Page object is stable across switches and the transport listener is registered
 * exactly once, which is what keeps the event stream leak-free.
 */
export function useRemotePage(): RemotePage {
  const ref = useRef<RemotePage | null>(null)
  if (!ref.current) {
    ref.current = createRemotePage(window.cdp)
  }
  return ref.current
}
