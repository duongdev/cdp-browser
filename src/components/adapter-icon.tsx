import { useEffect, useState } from "react"
import { iconFallbackForEntry, iconForEntry, type ViewEntry } from "@/lib/notifications-view"

interface Props {
  entry: ViewEntry
  className?: string
}

/**
 * Notification adapter icon (t089). Loads the real brand favicon (via a stable favicon
 * service) and falls back to the bundled same-origin letter tile if that fails, then hides
 * entirely if both fail. Centralizes the icon + onError swap that the Inbox, bell popover,
 * and Conversation Reader all need.
 */
export function AdapterIcon({ entry, className }: Props) {
  const primary = iconForEntry(entry)
  const fallback = iconFallbackForEntry(entry)
  const [src, setSrc] = useState(primary ?? fallback)
  // Reset when the entry's icon source changes (list re-renders reuse the component).
  useEffect(() => {
    setSrc(primary ?? fallback)
  }, [primary, fallback])

  if (!src) return null
  return (
    <img
      alt=""
      className={className}
      onError={() => {
        if (fallback && src !== fallback) setSrc(fallback)
        else setSrc(undefined)
      }}
      src={src}
    />
  )
}
