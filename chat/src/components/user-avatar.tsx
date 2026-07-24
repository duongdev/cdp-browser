import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"

interface UserAvatarProps {
  /** The user oid/MRI whose Graph photo to load (t153). Absent → initials only (a group chat). */
  userId?: string
  /** The display name the initial is taken from; also the img alt. */
  label: string
  /** Tailwind size class for the square box (default size-10, a conversation row). */
  className?: string
}

/** A user avatar: the initial-letter tile always renders behind; when `userId` resolves a real
 *  Graph photo (`/api/teams/avatar`), the img fades in absolutely on top — same fixed box, so a
 *  load/miss never shifts layout. A 204 (no photo) or any error keeps the initials (the img's
 *  `onError`, since a 204 has no decodable body). Photos are proxied + cached server-side. */
/** Teams-style composite avatar for a group chat (t161): the first two members' photos as two
 *  overlapping circles inside the same fixed box a single avatar uses — no layout shift, initials
 *  fallback per circle. */
export function FacepileAvatar({
  memberIds,
  label,
  className,
}: {
  memberIds: string[]
  label: string
  className?: string
}) {
  const [a, b] = memberIds
  return (
    // `block` is load-bearing (t170 regression fix): as a plain inline span, `size-10` is ignored
    // whenever this ISN'T a direct flex item (e.g. inside a positioning wrapper), and the absolute
    // circles anchor to a collapsed box and spill across the row.
    // Circles sit top-RIGHT + bottom-LEFT (t170 redesign): the top-right circle anchors the
    // avatar-corner unread dot exactly like a single avatar, so the dot never floats in an empty
    // quadrant of the facepile box.
    <span
      aria-label={label}
      className={cn("relative block size-10 shrink-0", className)}
      role="img"
    >
      <UserAvatar
        className="absolute top-0 right-0 size-[26px] text-[10px]"
        label={label.split(",")[0]?.trim() || label}
        userId={a}
      />
      <UserAvatar
        className="absolute bottom-0 left-0 size-[26px] text-[10px] ring-2 ring-background"
        label={label.split(",")[1]?.trim() || label}
        userId={b}
      />
    </span>
  )
}

export function UserAvatar({ userId, label, className }: UserAvatarProps) {
  const [failed, setFailed] = useState(false)

  // Reset the error state when the user changes (a keep-alive row reused for another conversation).
  // biome-ignore lint/correctness/useExhaustiveDependencies: userId is the deliberate reset trigger
  useEffect(() => setFailed(false), [userId])

  const src = userId && !failed ? `/api/teams/avatar?userId=${encodeURIComponent(userId)}` : null

  return (
    <span
      className={cn(
        "relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/10 text-sm font-medium text-primary",
        className,
      )}
    >
      {label.charAt(0).toUpperCase()}
      {src && (
        <img
          alt={label}
          className="absolute inset-0 size-full rounded-full object-cover"
          onError={() => setFailed(true)}
          src={src}
        />
      )}
    </span>
  )
}
