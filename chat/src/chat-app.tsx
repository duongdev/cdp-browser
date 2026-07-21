import { BubbleChatIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useEffect, useState } from "react"
import { ConversationList } from "./components/conversation-list"
import { ThreadView } from "./components/thread-view"
import type { TeamsConversation } from "./lib/teams-client"

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
 *  conversation list beside the thread; narrow shows one at a time with a back button. */
export function ChatApp() {
  const [selected, setSelected] = useState<TeamsConversation | null>(null)
  const isWide = useIsWide()

  if (isWide) {
    return (
      <div className="mx-auto flex h-[var(--app-h,100dvh)] w-full max-w-6xl bg-background">
        <aside className="flex w-80 shrink-0 flex-col border-border border-r">
          <AppHeader />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ConversationList onOpenConversation={setSelected} selectedId={selected?.id ?? null} />
          </div>
        </aside>
        <section className="min-w-0 flex-1">
          {selected ? (
            <ThreadView conversation={selected} />
          ) : (
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
      {selected ? (
        <ThreadView conversation={selected} onBack={() => setSelected(null)} />
      ) : (
        <>
          <AppHeader />
          <main className="min-h-0 flex-1 overflow-y-auto">
            <ConversationList onOpenConversation={setSelected} />
          </main>
        </>
      )}
    </div>
  )
}
