import {
  Building03Icon,
  Call02Icon,
  Location01Icon,
  Mail01Icon,
  Message01Icon,
  UserIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { fetchProfile, TeamsApiError, type TeamsProfile } from "../lib/teams-client"
import { UserAvatar } from "./user-avatar"

/** Who the dialog is about: the sender oid/MRI + the display name we already know (renders
 *  immediately while the Graph card loads). Null closes the dialog. */
export interface ProfileTarget {
  userId: string
  name: string
}

interface ProfileDialogProps {
  target: ProfileTarget | null
  onClose: () => void
  /** Open (or switch to) the 1:1 conversation with this user (t166). Only offered when the
   *  parent resolved an existing DM — absent hides the button. */
  onMessage?: (userId: string) => void
}

type LoadState =
  | { s: "loading" }
  | { s: "error"; code: string }
  | { s: "ready"; profile: TeamsProfile }

/** The org-directory profile card (t166): opened by clicking a sender's name/avatar. Shows the
 *  fullest Graph card the bearer can read — mail, title, department, office, phones — with the
 *  known display name rendering instantly while the card loads. Four-state per convention. */
export function ProfileDialog({ target, onClose, onMessage }: ProfileDialogProps) {
  const [state, setState] = useState<LoadState>({ s: "loading" })

  useEffect(() => {
    if (!target) return
    setState({ s: "loading" })
    const ctl = new AbortController()
    fetchProfile(target.userId, ctl.signal)
      .then((profile) => setState({ s: "ready", profile }))
      .catch((e) => {
        if (ctl.signal.aborted) return
        setState({ s: "error", code: e instanceof TeamsApiError ? e.code : "fetch_failed" })
      })
    return () => ctl.abort()
  }, [target])

  const profile = state.s === "ready" ? state.profile : null
  const name = profile?.displayName || target?.name || ""

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open={!!target}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <div className="flex items-center gap-4">
            <UserAvatar className="size-16 text-xl" label={name} userId={target?.userId} />
            <div className="min-w-0">
              <DialogTitle className="truncate">{name}</DialogTitle>
              {profile?.jobTitle && (
                <p className="truncate text-muted-foreground text-sm">{profile.jobTitle}</p>
              )}
            </div>
          </div>
        </DialogHeader>

        {state.s === "loading" && (
          <div className="flex flex-col gap-2.5 py-1">
            {[0, 1, 2].map((i) => (
              <div className="h-4 w-3/4 animate-pulse rounded bg-muted" key={i} />
            ))}
          </div>
        )}

        {state.s === "error" && (
          <p className="py-1 text-muted-foreground text-sm">{profileErrorCopy(state.code)}</p>
        )}

        {profile && (
          <div className="flex flex-col gap-2.5 py-1">
            <ProfileField icon={Mail01Icon} label="Email">
              {profile.mail ? (
                <a className="text-primary hover:underline" href={`mailto:${profile.mail}`}>
                  {profile.mail}
                </a>
              ) : null}
            </ProfileField>
            <ProfileField icon={Building03Icon} label="Department">
              {profile.department || null}
            </ProfileField>
            <ProfileField icon={Location01Icon} label="Office">
              {profile.officeLocation || null}
            </ProfileField>
            <ProfileField icon={Call02Icon} label="Phone">
              {profile.phones.length > 0 ? profile.phones.join(" · ") : null}
            </ProfileField>
            {!profile.mail &&
              !profile.department &&
              !profile.officeLocation &&
              profile.phones.length === 0 && (
                <p className="flex items-center gap-2 text-muted-foreground text-sm">
                  <HugeiconsIcon className="size-4" icon={UserIcon} />
                  No directory details available.
                </p>
              )}
          </div>
        )}

        {onMessage && target && (
          <Button className="w-full" onClick={() => onMessage(target.userId)}>
            <HugeiconsIcon className="size-4" icon={Message01Icon} />
            Message
          </Button>
        )}
      </DialogContent>
    </Dialog>
  )
}

function profileErrorCopy(code: string): string {
  if (code === "invalid_auth") return "Couldn't load — Teams sign-in expired."
  if (code === "not_found") return "This user isn't in the directory."
  if (code === "no_teams_tab") return "Couldn't load — no live Teams tab to fetch through."
  return "Couldn't load the profile. Try again."
}

/** One labelled row of the card. A null child (field absent in the directory) renders nothing —
 *  the card only shows what it actually knows. */
function ProfileField({
  icon,
  label,
  children,
}: {
  icon: IconSvgElement
  label: string
  children: React.ReactNode
}) {
  if (children == null || children === "") return null
  return (
    <div className="flex items-start gap-2 text-sm">
      <HugeiconsIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" icon={icon} />
      <div className="min-w-0">
        <span className="mr-1.5 text-muted-foreground">{label}</span>
        <span className="[overflow-wrap:anywhere]">{children}</span>
      </div>
    </div>
  )
}
