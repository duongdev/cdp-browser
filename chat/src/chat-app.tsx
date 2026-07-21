import { BubbleChatIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useCallback, useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import { ConversationList } from "./components/conversation-list"
import { ThreadView } from "./components/thread-view"
import type { TeamsConversation } from "./lib/teams-client"
import { EMPTY_KEEPALIVE, type KeepAliveState, openThread } from "./lib/thread-keepalive"

// Reactive wide/narrow gate (t107). Wide (≥768px) shows the two-pane list+thread; narrow stacks
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
    </header>
  )
}

/** Root of the standalone Teams chat app (t106/t107, ADR-0018). List+pane: wide shows the
 *  conversation list beside the thread; narrow shows one at a time with a back button.
 *
 *  Instant switch (t110): every opened conversation's thread stays mounted (its own pane, hidden
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

  const openConversation = useCallback((conv: TeamsConversation) => {
    setConvById((m) => (m[conv.id] === conv ? m : { ...m, [conv.id]: conv }))
    setKeepAlive((s) => openThread(s, conv.id))
    setPhoneView("thread")
  }, [])

  const backToList = useCallback(() => setPhoneView("list"), [])

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
            onOpenConversation={openConversation}
            selectedId={keepAlive.active || null}
          />
        </main>
      </div>
      <div className={cn("min-h-0 flex-1", phoneView === "list" && "hidden")}>{threadPanes}</div>
    </div>
  )
}
