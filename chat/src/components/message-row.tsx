import { type MouseEvent, useState } from "react"
import { cn } from "@/lib/utils"
import { relativeTime } from "../lib/conversation-view"
import { sanitize } from "../lib/sanitize-message"
import type { TeamsMessage } from "../lib/teams-client"
import { ImageLightbox } from "./image-lightbox"

interface MessageRowProps {
  message: TeamsMessage
}

/** One message bubble. Own messages align right with the accent; others align left with the
 *  sender name. `body` is rich, site-authored HTML (t111) — bold/links/mentions/emoji/code/lists,
 *  plus inline media (t117: AMS images/video via the proxy, public-CDN emoji/GIF/sticker). */
export function MessageRow({ message }: MessageRowProps) {
  const { self, deleted } = message
  const time = relativeTime(message.ts)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)

  // A tap on a content image (not an emoji/sticker) opens the lightbox with that image's src.
  // Delegated off the body so it covers every img the sanitized HTML produced.
  function onBodyClick(e: MouseEvent<HTMLDivElement>) {
    const el = e.target as HTMLElement
    if (el.tagName !== "IMG") return
    const itemtype = el.getAttribute("itemtype") || ""
    if (/Emoji|Sticker/i.test(itemtype) || el.classList.contains("emoji")) return
    const src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src
    if (src) setLightboxSrc(src)
  }

  return (
    <div className={cn("flex flex-col gap-0.5", self ? "items-end" : "items-start")}>
      {!self && (
        <span className="px-1 font-medium text-muted-foreground text-xs">{message.senderName}</span>
      )}
      {/* XSS BOUNDARY: message.body is site-authored HTML. It MUST pass through sanitize() (DOMPurify,
          strict allowlist) before it hits the DOM — never render body raw. This is the only guard. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: delegated image-tap opens a lightbox. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: image-tap enhancement; the lightbox is Esc-dismissable. */}
      <div
        className={cn(
          "teams-message-body max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-snug [overflow-wrap:anywhere]",
          self ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
          deleted && "italic opacity-70",
        )}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitize() is the XSS boundary (t111)
        dangerouslySetInnerHTML={{ __html: sanitize(message.body) }}
        onClick={onBodyClick}
      />
      <span className="px-1 font-mono text-[10px] text-muted-foreground">
        {time}
        {message.edited && !deleted && <span className="ml-1">(edited)</span>}
      </span>
      <ImageLightbox onClose={() => setLightboxSrc(null)} src={lightboxSrc} />
    </div>
  )
}
