import { BubbleChatIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useCallback, useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import { ConversationList } from "./components/conversation-list"
import { NotifyToggle } from "./components/notify-toggle"
import { ThreadView } from "./components/thread-view"
import { parsePath, pathFor } from "./lib/chat-route"
import type { TeamsConversation } from "./lib/teams-client"
import { EMPTY_KEEPALIVE, type KeepAliveState, openThread } from "./lib/thread-keepalive"

// Reactive wide/narrow gate (t129). Wide (≥768px) shows the two-pane list+thread; narrow stacks
// list → thread → back. matchMedia over a resize listener — it fires only on the boundary cross.
function useIsWide() {
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 768px)").matches)
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)")
    const on = () => setWide(mq.matches)
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [])
  return wide
}

function AppHeader() {
  return (
    <header className="flex items-center gap-2 border-border border-b px-4 py-3">
      <HugeiconsIcon className="size-5 text-primary" icon={BubbleChatIcon} />
      <h1 className="font-heading font-semibold text-base text-foreground">Teams Chat</h1>
      <div className="ml-auto">
        <NotifyToggle />
      </div>
    </header>
  )
}

// A placeholder conversation for a push deep-link — we only know the id. ThreadView fetches history
// + sender names by id; a later list tap replaces this with the real row (title etc.).
// ponytail: header shows a kind-label ("Direct message") until then — the deep-link only carries id.
function stubConversation(id: string): TeamsConversation {
  return {
    id,
    kind: "oneOnOne",
    topic: null,
    lastMessageId: null,
    lastMessageVersion: 0,
    lastMessageTs: null,
    lastMessagePreview: "",
    muted: false,
  }
}

/** Root of the standalone Teams chat app (t128/t129, ADR-0019). List+pane: wide shows the
 *  conversation list beside the thread; narrow shows one at a time with a back button.
 *
 *  Instant switch (t132): every opened conversation's thread stays mounted (its own pane, hidden
 *  when inactive via display:none) so switching is a pure visibility toggle — no remount, no
 *  refetch, scroll retained. The pure keep-alive model (`openThread`) decides which panes mount and
 *  which is active + evicts the least-recently-viewed past the cap; this component only renders. */
export function ChatApp() {
  const isWide = useIsWide()
  const [keepAlive, setKeepAlive] = useState<KeepAliveState>(EMPTY_KEEPALIVE)
  // Conversation metadata by id, so an inactive-but-mounted pane can still render. Grows only with
  // distinct conversations opened in a session (tiny objects) — not pruned on eviction.
  const [convById, setConvById] = useState<Record<string, TeamsConversation>>({})
  // Phone only: which surface is on screen. The thread panes stay mounted while the list shows.
  const [phoneView, setPhoneView] = useState<"list" | "thread">("list")

  // The URL is the state (t150): `/chat/c/{id}` is an open conversation, `/chat/` is the list.
  // A user-driven open pushes; a popstate-driven one replays history without re-pushing.
  const openConversation = useCallback((conv: TeamsConversation) => {
    setConvById((m) => (m[conv.id] === conv ? m : { ...m, [conv.id]: conv }))
    setKeepAlive((s) => openThread(s, conv.id))
    setPhoneView("thread")
    const path = pathFor(conv.id)
    if (window.location.pathname !== path) window.history.pushState(null, "", path)
  }, [])

  const openConversationById = useCallback((id: string, push = true) => {
    setConvById((m) => (m[id] ? m : { ...m, [id]: stubConversation(id) }))
    setKeepAlive((s) => openThread(s, id))
    setPhoneView("thread")
    const path = pathFor(id)
    if (push && window.location.pathname !== path) window.history.pushState(null, "", path)
  }, [])

  // Push deep-link (t147): a cold tap lands with ?conv=<id> in the URL; a warm tap (window already
  // open) arrives as an SW postMessage { type:"open-conv", convId }. Both open that conversation;
  // strip ?conv= after consuming so a refresh doesn't reopen.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const conv = params.get("conv")
    if (conv) {
      openConversationById(conv)
      params.delete("conv")
      const qs = params.toString()
      window.history.replaceState(
        null,
        "",
        window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
      )
    }
    const sw = navigator.serviceWorker
    if (!sw) return
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "open-conv" && typeof e.data.convId === "string")
        openConversationById(e.data.convId)
    }
    sw.addEventListener("message", onMessage)
    return () => sw.removeEventListener("message", onMessage)
  }, [openConversationById])

  // Boot from the URL + follow browser back/forward (t150). On boot, a `/chat/c/{id}` path opens
  // that conversation (ThreadView fetches by id alone, with its own error state for a gone id).
  // popstate replays whatever the current path encodes: an id opens its thread, the list path
  // pops back — on phone that back-swipe returns to the list.
  useEffect(() => {
    const route = parsePath(window.location.pathname)
    if (route) openConversationById(route.convId, false)
    const onPop = () => {
      const r = parsePath(window.location.pathname)
      if (r) openConversationById(r.convId, false)
      else setPhoneView("list")
    }
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [openConversationById])

  // Late-arriving list metadata (t150 fix): a deep-linked pane mounts with a stub conversation
  // (id only). When the list loads/merges, swap any tracked entry for the real object so the
  // thread header picks up the resolved title. Only ids already tracked are stored.
  const onConversations = useCallback((list: TeamsConversation[]) => {
    setConvById((m) => {
      let next = m
      for (const c of list) {
        if (m[c.id] && m[c.id] !== c) {
          if (next === m) next = { ...m }
          next[c.id] = c
        }
      }
      return next
    })
  }, [])

  const backToList = useCallback(() => {
    setPhoneView("list")
    if (window.location.pathname !== "/chat/") window.history.pushState(null, "", "/chat/")
  }, [])

  const threadPanes = keepAlive.mounted.map((id) => {
    const conv = convById[id]
    if (!conv) return null
    return (
      <ThreadView
        conversation={conv}
        key={id}
        onBack={isWide ? undefined : backToList}
        visible={id === keepAlive.active && (isWide || phoneView === "thread")}
      />
    )
  })

  if (isWide) {
    return (
      <div className="mx-auto flex h-[var(--app-h,100dvh)] w-full max-w-6xl bg-background">
        <aside className="flex w-80 shrink-0 flex-col border-border border-r">
          <AppHeader />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ConversationList
              onConversations={onConversations}
              onOpenConversation={openConversation}
              selectedId={keepAlive.active || null}
            />
          </div>
        </aside>
        <section className="min-w-0 flex-1">
          {threadPanes}
          {keepAlive.mounted.length === 0 && (
            <div className="flex h-full items-center justify-center px-6 text-center text-muted-foreground text-sm">
              Select a conversation
            </div>
          )}
        </section>
      </div>
    )
  }

  return (
    <div className="mx-auto flex h-[var(--app-h,100dvh)] w-full max-w-2xl flex-col bg-background">
      <div className={cn("flex min-h-0 flex-1 flex-col", phoneView === "thread" && "hidden")}>
        <AppHeader />
        <main className="min-h-0 flex-1 overflow-y-auto">
          <ConversationList
            onConversations={onConversations}
            onOpenConversation={openConversation}
            selectedId={keepAlive.active || null}
          />
        </main>
      </div>
      <div className={cn("min-h-0 flex-1", phoneView === "list" && "hidden")}>{threadPanes}</div>
    </div>
  )
}
