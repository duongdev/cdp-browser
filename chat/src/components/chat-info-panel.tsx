import { Cancel01Icon, UserGroupIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { fetchRoster } from "../lib/chat-client"
import { conversationLabel } from "../lib/conversation-view"
import { FULL_NAME, type NamePref } from "../lib/display-name"
import type { RosterMember, TeamsConversation } from "../lib/teams-client"
import { DisplayName } from "./display-name"
import { UserAvatar } from "./user-avatar"

type RosterState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; members: RosterMember[] }

/** Chat info / details panel (PSN-116 WS-C). Lives in the same right column as the AI assistant
 *  (mutually exclusive — opening one closes the other) and inherits its width + drag-resize seam.
 *  Content is the group roster: avatar + display name, self marked "(you)". A 1:1/self has no
 *  separate roster endpoint, so it shows only the conversation identity. Best-effort — a roster
 *  failure shows an honest retry, never a crash. */
export function ChatInfoPanel({
  conversation,
  namePref = FULL_NAME,
  onClose,
  onOpenProfile,
}: {
  conversation: TeamsConversation
  namePref?: NamePref
  onClose: () => void
  /** Open a member's profile card — the same target shape a message sender header uses, so both
   *  entry points land in the one ProfileDialog chat-app owns. */
  onOpenProfile?: (target: { userId: string; name: string }) => void
}) {
  const [state, setState] = useState<RosterState>({ status: "loading" })
  const [retry, setRetry] = useState(0)
  const convId = conversation.id
  const isGroup = conversation.kind === "group"

  useEffect(() => {
    // Only a group carries a separate roster endpoint; a 1:1/self derives its participants from the
    // conversation row itself, so skip the fetch there.
    if (!isGroup) {
      setState({ status: "ready", members: [] })
      return
    }
    let live = true
    setState({ status: "loading" })
    fetchRoster(convId)
      .then((members) => live && setState({ status: "ready", members }))
      .catch(() => live && setState({ status: "error" }))
    return () => {
      live = false
    }
  }, [convId, isGroup, retry])

  const title = conversation.customTitle || conversationLabel(conversation)

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="titlebar flex h-12 shrink-0 items-center justify-between gap-1 border-border border-b px-3">
        <span className="truncate font-heading font-semibold text-foreground text-sm">Details</span>
        <Button
          aria-label="Close details"
          className="text-muted-foreground"
          onClick={onClose}
          size="icon-sm"
          variant="ghost"
        >
          <HugeiconsIcon className="size-4" icon={Cancel01Icon} />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        {/* Conversation identity */}
        <div className="mb-4 flex flex-col items-center gap-2 text-center">
          {isGroup ? (
            <span className="flex size-14 items-center justify-center rounded-full bg-muted">
              <HugeiconsIcon className="size-7 text-muted-foreground" icon={UserGroupIcon} />
            </span>
          ) : (
            <UserAvatar
              className="size-14 text-base"
              label={title}
              size="240x240"
              userId={conversation.avatarUserId}
            />
          )}
          <span className="font-heading font-semibold text-foreground text-sm">{title}</span>
        </div>

        {isGroup && (
          <MemberSection
            namePref={namePref}
            onOpenProfile={onOpenProfile}
            onRetry={() => setRetry((n) => n + 1)}
            state={state}
          />
        )}
      </div>
    </div>
  )
}

function MemberSection({
  state,
  namePref,
  onRetry,
  onOpenProfile,
}: {
  state: RosterState
  namePref: NamePref
  onRetry: () => void
  onOpenProfile?: (target: { userId: string; name: string }) => void
}) {
  if (state.status === "loading") {
    return (
      <ul className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <li className="flex items-center gap-2" key={i}>
            <span className="size-8 shrink-0 animate-pulse rounded-full bg-muted" />
            <span className="h-3.5 w-1/2 animate-pulse rounded bg-muted" />
          </li>
        ))}
      </ul>
    )
  }
  if (state.status === "error") {
    return (
      <div className="flex flex-col items-center gap-2 py-6 text-center">
        <p className="text-muted-foreground text-sm">Couldn't load members.</p>
        <Button onClick={onRetry} size="sm" variant="secondary">
          Retry
        </Button>
      </div>
    )
  }
  const members = state.members
  return (
    <>
      <p className="mb-2 px-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
        {members.length} {members.length === 1 ? "member" : "members"}
      </p>
      <ul className="flex flex-col">
        {members.map((m) => {
          const row = (
            <>
              <UserAvatar className="size-8 text-xs" label={m.name} userId={m.mri} />
              <DisplayName
                className="min-w-0 truncate text-foreground text-sm"
                name={m.name}
                pref={namePref}
              />
              {m.self && <span className="shrink-0 text-muted-foreground text-xs">(you)</span>}
            </>
          )
          // A member with a resolvable id opens the same profile card as their message header; one
          // without stays static text rather than a button that would do nothing on click.
          return (
            <li key={m.mri}>
              {onOpenProfile && m.mri ? (
                <button
                  className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none"
                  onClick={() => onOpenProfile({ userId: m.mri, name: m.name })}
                  type="button"
                >
                  {row}
                </button>
              ) : (
                <span className="flex items-center gap-2 rounded-lg px-1 py-1.5">{row}</span>
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}
