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
import { avatarUrl, ChatApiError, fetchProfile } from "../lib/chat-client"
import type { TeamsProfile } from "../lib/teams-client"
import { ImageLightbox } from "./image-lightbox"
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
  const [photoLoaded, setPhotoLoaded] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)

  useEffect(() => {
    if (!target) return
    setState({ s: "loading" })
    setPhotoLoaded(false)
    setLightboxOpen(false)
    const ctl = new AbortController()
    fetchProfile(target.userId, ctl.signal)
      .then((profile) => setState({ s: "ready", profile }))
      .catch((e) => {
        if (ctl.signal.aborted) return
        setState({ s: "error", code: e instanceof ChatApiError ? e.code : "fetch_failed" })
      })
    return () => ctl.abort()
  }, [target])

  const profile = state.s === "ready" ? state.profile : null
  const name = profile?.displayName || target?.name || ""
  const lightboxSrc = target?.userId ? avatarUrl(target.userId, "648x648") : null

  return (
    <>
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setLightboxOpen(false)
            onClose()
          }
        }}
        open={!!target}
      >
        {/* No Escape/outside-click guards here: the lightbox is its own Radix layer, and Radix only
            dismisses the TOP layer — so Escape reaches this dialog only once the lightbox is gone.
            The card fades out while the lightbox is up: a dialog card paints ABOVE any later
            fixed sibling in this app regardless of z-index (reproducible with a plain z-100 div,
            no lightbox involved), so it would otherwise sit on the lightbox's dim backdrop. It is
            already `aria-hidden` at that point, so hiding it visually just matches the semantics. */}
        <DialogContent
          className={`max-w-sm transition-opacity duration-150 ${lightboxOpen ? "opacity-0" : ""}`}
        >
          <DialogHeader className="min-w-0">
            <div className="flex min-w-0 items-center gap-4">
              {/* One button (no remount → no image flicker), disabled until a real photo loads, so the
                  zoom affordance only appears when there's something to zoom (initials → inert). */}
              <button
                aria-label="View full-size avatar"
                className="shrink-0 rounded-full disabled:cursor-default enabled:cursor-zoom-in"
                disabled={!photoLoaded}
                onClick={() => setLightboxOpen(true)}
                type="button"
              >
                <UserAvatar
                  className="size-16 text-xl"
                  label={name}
                  onPhotoLoad={() => setPhotoLoaded(true)}
                  size="240x240"
                  userId={target?.userId}
                />
              </button>
              {/* Identity block: the name wraps (it's the one thing you must be able to read in
                  full — capped at 2 lines so a pathological one can't stretch the card), the job
                  title clamps to 2 lines with the full string on hover. Both break inside a long
                  unbroken token, so neither can widen the card. */}
              <div className="min-w-0 space-y-1">
                <DialogTitle
                  className="line-clamp-2 [overflow-wrap:anywhere] leading-tight"
                  title={name}
                >
                  {name}
                </DialogTitle>
                {profile?.jobTitle && (
                  <p
                    className="line-clamp-2 [overflow-wrap:anywhere] text-muted-foreground text-sm leading-snug"
                    title={profile.jobTitle}
                  >
                    {profile.jobTitle}
                  </p>
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
              <ProfileField
                clamp
                fullText={profile.department ?? undefined}
                icon={Building03Icon}
                label="Department"
              >
                {profile.department || null}
              </ProfileField>
              <ProfileField
                clamp
                fullText={profile.officeLocation ?? undefined}
                icon={Location01Icon}
                label="Office"
              >
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
      {lightboxSrc && (
        <ImageLightbox
          media={lightboxOpen ? { src: lightboxSrc, kind: "image" } : null}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </>
  )
}

function profileErrorCopy(code: string): string {
  if (code === "invalid_auth") return "Couldn't load — Teams sign-in expired."
  if (code === "not_found") return "This user isn't in the directory."
  if (code === "no_teams_tab") return "Couldn't load — no live Teams tab to fetch through."
  return "Couldn't load the profile. Try again."
}

/** One labelled row of the card. A null child (field absent in the directory) renders nothing —
 *  the card only shows what it actually knows. Values always break inside a long unbroken token so
 *  they can't widen the card; `clamp` additionally caps prose-y fields (department, office) at two
 *  lines with the full text on hover, while contact details (mail, phone) wrap in full because a
 *  half-shown address is useless. */
function ProfileField({
  icon,
  label,
  clamp,
  fullText,
  children,
}: {
  icon: IconSvgElement
  label: string
  clamp?: boolean
  fullText?: string
  children: React.ReactNode
}) {
  if (children == null || children === "") return null
  return (
    <div className="flex min-w-0 items-start gap-2 text-sm">
      <HugeiconsIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" icon={icon} />
      <div className={`min-w-0 ${clamp ? "line-clamp-2" : ""}`} title={fullText}>
        <span className="mr-1.5 text-muted-foreground">{label}</span>
        <span className="[overflow-wrap:anywhere]">{children}</span>
      </div>
    </div>
  )
}
