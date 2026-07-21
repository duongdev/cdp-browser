import { BubbleChatIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { ConversationList } from "./components/conversation-list"

// Opening a conversation is wired but inert until t107 renders the thread pane. Kept as a
// named handler (not an inline noop) so t107 replaces one function and the wiring is already there.
function openConversation(_convId: string) {
  // t107: route to the conversation reader / thread pane.
}

/** Root of the standalone Teams chat app (t106, ADR-0018). The conversation list is the left
 *  column of the eventual list+pane; the pane lands in t107. */
export function ChatApp() {
  return (
    <div className="mx-auto flex h-[var(--app-h,100dvh)] w-full max-w-2xl flex-col bg-background">
      <header className="flex items-center gap-2 border-border border-b px-4 py-3">
        <HugeiconsIcon className="size-5 text-primary" icon={BubbleChatIcon} />
        <h1 className="font-heading font-semibold text-base text-foreground">Teams Chat</h1>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <ConversationList onOpenConversation={openConversation} />
      </main>
    </div>
  )
}
