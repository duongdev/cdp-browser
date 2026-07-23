import {
  ArrowTurnBackwardIcon,
  Cancel01Icon,
  Csv01Icon,
  Delete02Icon,
  Doc01Icon,
  File01Icon,
  Image01Icon,
  MoreHorizontalIcon,
  Note01Icon,
  Pdf01Icon,
  PencilEdit02Icon,
  PlayCircleIcon,
  Ppt01Icon,
  SmileIcon,
  Tick01Icon,
  Xls01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { usePointerCoarse } from "@/hooks/use-pointer-coarse"
import { cn } from "@/lib/utils"
import { FULL_NAME, formatName, type NamePref } from "../lib/display-name"
import { htmlToPlain } from "../lib/html-to-plain"
import { sanitize } from "../lib/sanitize-message"
import type { TeamsAttachment, TeamsMessage, TeamsReaction } from "../lib/teams-client"
import { ImageLightbox } from "./image-lightbox"
import { UserAvatar } from "./user-avatar"

// The six Teams default reactions for the quick-react bar. Mirrors core/teams-emoji.js
// DEFAULT_REACTIONS — a frozen, closed set, kept local so the browser build needn't import the CJS
// core module (which the tsconfig doesn't typecheck). Chips carry their own emoji from the server.
const QUICK_REACTIONS: readonly { key: string; emoji: string }[] = [
  { key: "like", emoji: "👍" },
  { key: "heart", emoji: "❤️" },
  { key: "laugh", emoji: "😆" },
  { key: "surprised", emoji: "😮" },
  { key: "sad", emoji: "😢" },
  { key: "angry", emoji: "😠" },
]

// Hover tooltip listing who reacted (t143). The viewer is "You" (first) when `mine`; the rest are
// the server-resolved `reactorNames`. Names can be fewer than `count` (unresolved MRIs omitted), so
// any shortfall becomes "and N more". Empty → no title (chip still shows emoji + count).
function reactorTitle(r: TeamsReaction, pref: NamePref): string | undefined {
  const names = (r.reactorNames ?? []).map((n) => formatName(n, pref))
  const shown = r.mine ? ["You", ...names] : names
  if (shown.length === 0) return undefined
  const hidden = r.count - shown.length
  return hidden > 0 ? `${shown.join(", ")} and ${hidden} more` : shown.join(", ")
}

/** A keyboard command targeted at the focused row (t152). The `nonce` changes on each dispatch so a
 *  repeat of the same key re-fires the effect. chat-app → thread-view → the focused MessageRow. */
export interface RowCommand {
  type: "edit" | "delete" | "react"
  nonce: number
}

interface MessageRowProps {
  message: TeamsMessage
  /** Toggle the viewer's reaction for `key` on this message (t142). `remove` true → leave it.
   *  The parent (thread-view) applies the optimistic update + fires the server call. */
  onReact?: (msgId: string, key: string, emoji: string, remove: boolean) => void
  /** Edit the viewer's OWN message (t144). The parent optimistically updates the body + `edited`
   *  and returns the client promise, so this row keeps the inline editor open + shows an error on a
   *  rejected write. Only passed for own, non-deleted messages. */
  onEdit?: (msgId: string, text: string) => Promise<void> | void
  /** Delete the viewer's OWN message (t144). The parent optimistically tombstones it + fires the
   *  best-effort call. Only passed for own, non-deleted messages. */
  onDelete?: (msgId: string) => void
  /** Quote this message in the composer (PSN-92 B). Passed for any confirmed, non-deleted message. */
  onReply?: (msg: TeamsMessage) => void
  /** Retry a failed optimistic send in place (t159). Only meaningful for a `failed` message. */
  onRetrySend?: (msgId: string) => void
  /** Discard a failed optimistic send — removes the bubble (t159). */
  onDiscardSend?: (msgId: string) => void
  /** Keyboard focus (t152): draws a ring + scrolls into view. */
  focused?: boolean
  /** A keyboard command aimed at this row when it's focused (t152). Only acted on when `focused`. */
  command?: RowCommand
  /** Group leader (t158): show the avatar/name header + timestamp and a larger top gap. A follower
   *  (`false`) — same sender within 5min, same day — shows only the bubble, tight against the prior.
   *  Defaults true, so any caller not passing it renders the full (pre-grouping) row. */
  showMeta?: boolean
  /** Name display preference (t161) — applied to the sender header + reactor tooltips. */
  namePref?: NamePref
}

/** One message bubble. Own messages align right with the accent; others align left with the
 *  sender name. `body` is rich, site-authored HTML (t133) — bold/links/mentions/emoji/code/lists,
 *  plus inline media (t139: AMS images/video via the proxy, public-CDN emoji/GIF/sticker). File /
 *  call-recording / card chips (t141) render below the body; a chips-only message shows no bubble. */
/** Renders one thread row. A system-event line (t151) is a distinct render with no bubble/hooks, so
 *  it's dispatched to `SystemRow` here (before `ChatMessageRow`'s hooks) to keep hook order stable. */
export function MessageRow(props: MessageRowProps) {
  if (props.message.kind === "system") return <SystemRow body={props.message.body} />
  return <ChatMessageRow {...props} />
}

function ChatMessageRow({
  message,
  onReact,
  onEdit,
  onDelete,
  onReply,
  onRetrySend,
  onDiscardSend,
  focused,
  command,
  showMeta = true,
  namePref = FULL_NAME,
}: MessageRowProps) {
  const self = !!message.self
  const deleted = !!message.deleted
  // An optimistic send in flight / failed (t159): muted bubble, no react/manage until confirmed.
  const pending = !!message.pending
  const failed = message.failed != null
  const unconfirmed = pending || failed
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const coarse = usePointerCoarse()
  const attachments = message.attachments ?? []
  const reactions = message.reactions ?? []
  const hasBody = deleted || message.body.trim().length > 0
  const canReact = !deleted && !unconfirmed && !!onReact
  // Reply-with-quote (PSN-92 B): any confirmed, non-deleted message, own or others'.
  const canReply = !deleted && !unconfirmed && !!onReply
  // Own, non-deleted messages get the edit/delete menu (t144). A tombstone / others' message never does.
  const canManage = self && !deleted && !unconfirmed && (!!onEdit || !!onDelete)

  // Inline edit + delete-confirm state (t144).
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [saving, setSaving] = useState(false)
  const [editErr, setEditErr] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const editRef = useRef<HTMLTextAreaElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)

  // Auto-grow the editor up to a cap (mirrors the composer); re-measure on each keystroke.
  // biome-ignore lint/correctness/useExhaustiveDependencies: draft is the deliberate re-measure trigger
  useLayoutEffect(() => {
    const el = editRef.current
    if (!el || !editing) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [draft, editing])

  const startEdit = () => {
    setDraft(htmlToPlain(message.body))
    setEditErr(null)
    setEditing(true)
    // Focus + cursor-to-end after the textarea mounts.
    requestAnimationFrame(() => {
      const el = editRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }

  const cancelEdit = () => {
    setEditing(false)
    setEditErr(null)
    setSaving(false)
  }

  const saveEdit = async () => {
    const text = draft.trim()
    if (!text || saving) return
    setSaving(true)
    setEditErr(null)
    try {
      await onEdit?.(message.id, text)
      setEditing(false)
    } catch {
      // Keep the editor open with the typed text so the user can retry (spec: honest failure).
      setEditErr("Couldn't edit — sign-in may have expired. Try again.")
    } finally {
      setSaving(false)
    }
  }

  // Keyboard focus (t152): scroll the focused row into view (nearest — no jump when already shown).
  useEffect(() => {
    if (focused) rowRef.current?.scrollIntoView({ block: "nearest" })
  }, [focused])

  // Act on a keyboard command aimed at this row while it's focused (t152). The nonce re-fires the
  // effect on a repeat key. `e`/`r`/`⌫` route through the SAME inline flows a click would — edit
  // opens the editor, delete opens the AlertDialog confirm (never bypassed), react opens the bar.
  const cmdNonce = command?.nonce
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce is the deliberate re-fire trigger
  useEffect(() => {
    if (!focused || !command) return
    if (command.type === "edit" && canManage && onEdit) startEdit()
    else if (command.type === "delete" && canManage && onDelete) setConfirmOpen(true)
    else if (command.type === "react" && canReact) setPickerOpen(true)
  }, [cmdNonce])

  // Clicking a chip toggles my own reaction for that key (mine → remove, else join).
  const toggleChip = (r: TeamsReaction) => onReact?.(message.id, r.key, r.emoji, r.mine)
  // Tapping a quick-bar emoji adds it (a re-tap of one I already made is a no-op upstream).
  const quickReact = (key: string, emoji: string) => {
    setPickerOpen(false)
    onReact?.(message.id, key, emoji, false)
  }

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
    <div
      className={cn(
        "flex flex-col gap-0.5 rounded-2xl",
        self ? "items-end" : "items-start",
        // Vertical rhythm (t158): a group leader opens with a larger gap (≈16px) so distinct groups
        // read as blocks; a follower hugs the prior bubble (≈2px) for a tight Slack-style run.
        showMeta ? "mt-4 first:mt-0" : "mt-0.5",
        // Keyboard focus ring (t152): only paints once the user drives with the keyboard (chat-app
        // sets `focused`), so touch/mouse use never shows it. Uses the coral --ring token.
        focused && "-mx-1 px-1 ring-2 ring-ring/70 ring-offset-2 ring-offset-background",
      )}
      ref={rowRef}
    >
      {showMeta && !self && !!message.senderName && (
        <span className="flex items-center gap-1.5 px-1">
          <UserAvatar
            className="size-5 text-[10px]"
            label={message.senderName}
            userId={message.senderId}
          />
          <span className="font-semibold text-foreground text-xs">
            {formatName(message.senderName ?? "", namePref)}
          </span>
        </span>
      )}
      {hasBody && editing && (
        <div className="flex w-full max-w-[85%] flex-col gap-1 self-end">
          <textarea
            className="max-h-40 min-h-9 w-full resize-none rounded-2xl border border-input bg-background px-3 py-2 text-sm leading-snug outline-none focus:ring-1 focus:ring-ring"
            disabled={saving}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                void saveEdit()
              } else if (e.key === "Escape") {
                e.preventDefault()
                cancelEdit()
              }
            }}
            ref={editRef}
            rows={1}
            value={draft}
          />
          {editErr && <p className="text-destructive text-xs">{editErr}</p>}
          <div className="flex justify-end gap-1">
            <Button disabled={saving} onClick={cancelEdit} size="sm" variant="ghost">
              <HugeiconsIcon className="size-4" icon={Cancel01Icon} />
              Cancel
            </Button>
            <Button disabled={saving || !draft.trim()} onClick={() => void saveEdit()} size="sm">
              <HugeiconsIcon className="size-4" icon={Tick01Icon} />
              Save
            </Button>
          </div>
        </div>
      )}
      {hasBody && !editing && (
        <div
          className={cn(
            "group/msg flex max-w-full items-center gap-1",
            self ? "flex-row-reverse" : "flex-row",
          )}
        >
          {/* XSS BOUNDARY: message.body is site-authored HTML. It MUST pass through sanitize()
              (DOMPurify, strict allowlist) before it hits the DOM — never render body raw. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: delegated image-tap opens a lightbox. */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: image-tap enhancement; the lightbox is Esc-dismissable. */}
          <div
            className={cn(
              "teams-message-body max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-snug [overflow-wrap:anywhere] md:max-w-[65ch]",
              self ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
              // Mention-of-me highlight (t160): a coral-tinted bubble, Slack's mention background.
              message.mentionsMe && !self && "bg-ring/12 ring-1 ring-ring/30",
              deleted && "italic opacity-70",
              pending && "opacity-60",
              failed && "opacity-70 ring-1 ring-destructive/40",
            )}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitize() is the XSS boundary (t133)
            dangerouslySetInnerHTML={{ __html: sanitize(message.body) }}
            onClick={onBodyClick}
            // Exact sent time on hover (t160) — inline timestamps left the bubbles with Messenger-
            // style grouping; the tooltip is where "when exactly?" lives now.
            title={new Date(message.ts).toLocaleString()}
          />
          {(canReact || canManage || canReply) && (
            <div className="flex shrink-0 items-center gap-0.5">
              {canReply && <ReplyButton coarse={coarse} onClick={() => onReply?.(message)} />}
              {canReact && (
                <QuickReact
                  coarse={coarse}
                  onPick={quickReact}
                  onToggleOpen={() => setPickerOpen((v) => !v)}
                  open={pickerOpen}
                  side={self ? "end" : "start"}
                />
              )}
              {canManage && (
                <MessageActions
                  canDelete={!!onDelete}
                  canEdit={!!onEdit}
                  coarse={coarse}
                  onDelete={() => setConfirmOpen(true)}
                  onEdit={startEdit}
                  side={self ? "end" : "start"}
                />
              )}
            </div>
          )}
        </div>
      )}
      {canManage && onDelete && (
        <AlertDialog onOpenChange={setConfirmOpen} open={confirmOpen}>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete message?</AlertDialogTitle>
              <AlertDialogDescription>
                This deletes it for everyone. It can't be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => onDelete(message.id)} variant="destructive">
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {message.localImageUrl && (
        // Optimistic sent-image preview (t145): a local object-URL shown until the poll replaces this
        // message with the server's rendered AMSImage. Not sanitized HTML — it's our own blob URL.
        <img
          alt=""
          className="max-h-64 max-w-[85%] rounded-lg object-contain"
          src={message.localImageUrl}
        />
      )}
      {attachments.length > 0 && (
        <div className="flex max-w-[85%] flex-col gap-1">
          {attachments.map((a, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: attachments are immutable per message, no reorder
            <AttachmentChip attachment={a} key={i} />
          ))}
        </div>
      )}
      {reactions.length > 0 && (
        <div
          className={cn("flex max-w-[85%] flex-wrap gap-1", self ? "justify-end" : "justify-start")}
        >
          {reactions.map((r) => (
            <button
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors",
                r.mine
                  ? "border-primary bg-primary/15 text-foreground"
                  : "border-border bg-background/60 text-muted-foreground hover:bg-accent",
              )}
              disabled={!onReact}
              key={r.key}
              onClick={() => toggleChip(r)}
              title={reactorTitle(r, namePref)}
              type="button"
            >
              <span aria-hidden>{r.emoji}</span>
              <span className="font-mono">{r.count}</span>
            </button>
          ))}
        </div>
      )}
      {/* Optimistic send status (t159): a quiet "Sending…" while in flight; a failed send keeps the
          bubble with honest copy + retry/discard instead of blocking the composer. */}
      {pending && <span className="px-1 text-[10px] text-muted-foreground">Sending…</span>}
      {failed && (
        <span className="flex items-center gap-2 px-1 text-[11px] text-destructive">
          {sendErrorCopy(message.failed ?? "")}
          {onRetrySend && (
            <button
              className="font-semibold underline underline-offset-2"
              onClick={() => onRetrySend(message.id)}
              type="button"
            >
              Retry
            </button>
          )}
          {onDiscardSend && (
            <button
              className="text-muted-foreground underline underline-offset-2"
              onClick={() => onDiscardSend(message.id)}
              type="button"
            >
              Discard
            </button>
          )}
        </span>
      )}
      {/* No inline timestamps (t160, Messenger grouping) — separators + the bubble tooltip carry
          the time. The "(edited)" marker stays; it's meaning, not chrome. */}
      {!unconfirmed && message.edited && !deleted && (
        <span className="px-1 font-mono text-[10px] text-muted-foreground">(edited)</span>
      )}
      <ImageLightbox onClose={() => setLightboxSrc(null)} src={lightboxSrc} />
    </div>
  )
}

// Failed-send copy (t159) — honest and specific where we can be, generic otherwise.
function sendErrorCopy(code: string): string {
  if (code === "invalid_auth")
    return "Not sent — Teams sign-in expired; it refreshes when the Teams tab reloads."
  if (code === "rate_limited") return "Not sent — Teams is rate-limiting."
  return "Not sent."
}

/** A system-event line (t151): centered, muted, small — Slack/Linear-style meta row for member
 *  add/remove, call ended, rename, app added. Plain text, never HTML. */
function SystemRow({ body }: { body: string }) {
  return (
    <div className="flex justify-center py-0.5">
      <span className="rounded-full bg-muted/50 px-3 py-0.5 text-center text-muted-foreground text-xs">
        {body}
      </span>
    </div>
  )
}

/** The reply affordance beside a bubble (PSN-92 B): quotes the message into the composer. Same reveal
 *  as QuickReact — fade-in on hover for a fine pointer, always-visible for coarse. */
function ReplyButton({ coarse, onClick }: { coarse: boolean; onClick: () => void }) {
  return (
    <button
      aria-label="Reply"
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-opacity hover:bg-accent focus-visible:opacity-100",
        coarse ? "opacity-60" : "opacity-0 group-hover/msg:opacity-100",
      )}
      onClick={onClick}
      type="button"
    >
      <HugeiconsIcon className="size-4" icon={ArrowTurnBackwardIcon} />
    </button>
  )
}

/** The react affordance beside a bubble (t142): a smiley that reveals the six-default quick-react
 *  bar. Fine pointer → the smiley fades in on bubble hover; coarse pointer → it stays visible and a
 *  tap opens the bar (no hover to rely on). An open bar closes on an outside tap or after a pick. */
function QuickReact({
  coarse,
  open,
  onToggleOpen,
  onPick,
  side,
}: {
  coarse: boolean
  open: boolean
  onToggleOpen: () => void
  onPick: (key: string, emoji: string) => void
  side: "start" | "end"
}) {
  return (
    <div className="relative shrink-0">
      <button
        aria-expanded={open}
        aria-label="Add reaction"
        className={cn(
          "flex size-7 items-center justify-center rounded-full text-muted-foreground transition-opacity hover:bg-accent focus-visible:opacity-100",
          coarse ? "opacity-60" : "opacity-0 group-hover/msg:opacity-100",
        )}
        onClick={onToggleOpen}
        type="button"
      >
        <HugeiconsIcon className="size-4" icon={SmileIcon} />
      </button>
      {open && (
        <>
          {/* Outside-tap catcher — closes the bar without a document listener. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: click-away dismiss backdrop */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: Esc-independent dismiss; the bar buttons are focusable */}
          <div className="fixed inset-0 z-40" onClick={onToggleOpen} />
          <div
            className={cn(
              "absolute bottom-full z-50 mb-1 flex gap-0.5 rounded-full border border-border bg-popover px-1 py-0.5 shadow-md",
              side === "end" ? "right-0" : "left-0",
            )}
          >
            {QUICK_REACTIONS.map((r) => (
              <button
                aria-label={r.key}
                className="flex size-8 items-center justify-center rounded-full text-lg transition-transform hover:scale-125"
                key={r.key}
                onClick={() => onPick(r.key, r.emoji)}
                type="button"
              >
                {r.emoji}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** The own-message action affordance beside a bubble (t144): a ⋯ button that reveals an Edit/Delete
 *  menu. Same reveal as QuickReact — fade-in on hover for a fine pointer, always-visible for coarse —
 *  and the same outside-tap catcher to dismiss (no document listener). */
function MessageActions({
  coarse,
  canEdit,
  canDelete,
  onEdit,
  onDelete,
  side,
}: {
  coarse: boolean
  canEdit: boolean
  canDelete: boolean
  onEdit: () => void
  onDelete: () => void
  side: "start" | "end"
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative shrink-0">
      <button
        aria-expanded={open}
        aria-label="Message actions"
        className={cn(
          "flex size-7 items-center justify-center rounded-full text-muted-foreground transition-opacity hover:bg-accent focus-visible:opacity-100",
          coarse ? "opacity-60" : "opacity-0 group-hover/msg:opacity-100",
        )}
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <HugeiconsIcon className="size-4" icon={MoreHorizontalIcon} />
      </button>
      {open && (
        <>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: click-away dismiss backdrop */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: the menu buttons are focusable */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className={cn(
              "absolute bottom-full z-50 mb-1 flex min-w-32 flex-col rounded-lg border border-border bg-popover py-1 shadow-md",
              side === "end" ? "right-0" : "left-0",
            )}
          >
            {canEdit && (
              <button
                className="flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => {
                  setOpen(false)
                  onEdit()
                }}
                type="button"
              >
                <HugeiconsIcon className="size-4" icon={PencilEdit02Icon} />
                Edit
              </button>
            )}
            {canDelete && (
              <button
                className="flex items-center gap-2 px-3 py-1.5 text-left text-destructive text-sm hover:bg-accent"
                onClick={() => {
                  setOpen(false)
                  onDelete()
                }}
                type="button"
              >
                <HugeiconsIcon className="size-4" icon={Delete02Icon} />
                Delete
              </button>
            )}
          </div>
        </>
      )}
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

/** A file / call-recording / card chip below the message body (t141). A file opens SharePoint in a
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
    // A finished recording carries a SharePoint playback url (t162) → the chip opens it in a new tab
    // (browser SSO, like a file). Thumbnail with a play overlay when present, a play glyph otherwise.
    const inner = (
      <>
        {a.thumbnailUrl ? (
          <span className="relative size-9 shrink-0">
            <img
              alt=""
              className="size-9 rounded object-cover"
              loading="lazy"
              src={a.thumbnailUrl}
            />
            <HugeiconsIcon
              className="absolute inset-0 m-auto size-4 text-white drop-shadow"
              icon={PlayCircleIcon}
            />
          </span>
        ) : (
          <HugeiconsIcon className="size-5 shrink-0 text-muted-foreground" icon={PlayCircleIcon} />
        )}
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{a.title || "Call recording"}</span>
          <span className="text-[11px] text-muted-foreground">
            {a.url ? "Play recording" : "Recording"}
          </span>
        </span>
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
