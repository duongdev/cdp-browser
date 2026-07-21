import {
  Csv01Icon,
  Doc01Icon,
  File01Icon,
  Image01Icon,
  Note01Icon,
  Pdf01Icon,
  PlayCircleIcon,
  Ppt01Icon,
  Xls01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { type MouseEvent, useState } from "react"
import { cn } from "@/lib/utils"
import { relativeTime } from "../lib/conversation-view"
import { sanitize } from "../lib/sanitize-message"
import type { TeamsAttachment, TeamsMessage } from "../lib/teams-client"
import { ImageLightbox } from "./image-lightbox"

interface MessageRowProps {
  message: TeamsMessage
}

/** One message bubble. Own messages align right with the accent; others align left with the
 *  sender name. `body` is rich, site-authored HTML (t111) — bold/links/mentions/emoji/code/lists,
 *  plus inline media (t117: AMS images/video via the proxy, public-CDN emoji/GIF/sticker). File /
 *  call-recording / card chips (t119) render below the body; a chips-only message shows no bubble. */
export function MessageRow({ message }: MessageRowProps) {
  const { self, deleted } = message
  const time = relativeTime(message.ts)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const attachments = message.attachments ?? []
  const hasBody = deleted || message.body.trim().length > 0

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
      {hasBody && (
        <>
          {/* XSS BOUNDARY: message.body is site-authored HTML. It MUST pass through sanitize()
              (DOMPurify, strict allowlist) before it hits the DOM — never render body raw. */}
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
        </>
      )}
      {attachments.length > 0 && (
        <div className="flex max-w-[85%] flex-col gap-1">
          {attachments.map((a, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: attachments are immutable per message, no reorder
            <AttachmentChip attachment={a} key={i} />
          ))}
        </div>
      )}
      <span className="px-1 font-mono text-[10px] text-muted-foreground">
        {time}
        {message.edited && !deleted && <span className="ml-1">(edited)</span>}
      </span>
      <ImageLightbox onClose={() => setLightboxSrc(null)} src={lightboxSrc} />
    </div>
  )
}

const FILE_ICONS: Record<string, IconSvgElement> = {
  pdf: Pdf01Icon,
  doc: Doc01Icon,
  docx: Doc01Icon,
  xls: Xls01Icon,
  xlsx: Xls01Icon,
  csv: Csv01Icon,
  ppt: Ppt01Icon,
  pptx: Ppt01Icon,
  png: Image01Icon,
  jpg: Image01Icon,
  jpeg: Image01Icon,
  gif: Image01Icon,
  webp: Image01Icon,
  heic: Image01Icon,
}

function fileIcon(type?: string): IconSvgElement {
  return FILE_ICONS[(type ?? "").toLowerCase()] ?? File01Icon
}

const CHIP_CLASS =
  "inline-flex max-w-full items-center gap-2 rounded-lg border bg-background/60 px-2.5 py-1.5 text-left text-xs text-foreground no-underline transition-colors hover:bg-accent"

/** A file / call-recording / card chip below the message body (t119). A file opens SharePoint in a
 *  new tab; recordings/cards show a proxied thumbnail preview (no inline playback). */
function AttachmentChip({ attachment: a }: { attachment: TeamsAttachment }) {
  if (a.kind === "file") {
    const inner = (
      <>
        <HugeiconsIcon className="size-4 shrink-0 text-muted-foreground" icon={fileIcon(a.type)} />
        <span className="truncate">{a.name || "file"}</span>
      </>
    )
    return a.url ? (
      <a className={CHIP_CLASS} href={a.url} rel="noopener noreferrer" target="_blank">
        {inner}
      </a>
    ) : (
      <span className={cn(CHIP_CLASS, "cursor-default")}>{inner}</span>
    )
  }

  if (a.kind === "recording") {
    return (
      <span className={cn(CHIP_CLASS, "cursor-default")}>
        {a.thumbnailUrl ? (
          <img
            alt=""
            className="size-9 shrink-0 rounded object-cover"
            loading="lazy"
            src={a.thumbnailUrl}
          />
        ) : (
          <HugeiconsIcon className="size-5 shrink-0 text-muted-foreground" icon={PlayCircleIcon} />
        )}
        <span className="flex items-center gap-1">
          <HugeiconsIcon className="size-4 shrink-0 text-muted-foreground" icon={PlayCircleIcon} />
          Call recording
        </span>
      </span>
    )
  }

  // card
  return (
    <span className={cn(CHIP_CLASS, "cursor-default")}>
      {a.thumbnailUrl ? (
        <img
          alt=""
          className="size-9 shrink-0 rounded object-cover"
          loading="lazy"
          src={a.thumbnailUrl}
        />
      ) : (
        <HugeiconsIcon className="size-4 shrink-0 text-muted-foreground" icon={Note01Icon} />
      )}
      <span className="truncate">{a.title || "Card"}</span>
    </span>
  )
}
