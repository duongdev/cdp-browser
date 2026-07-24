import {
  ArrowUp01Icon,
  Attachment01Icon,
  Cancel01Icon,
  File01Icon,
  LeftToRightListBulletIcon,
  LeftToRightListNumberIcon,
  TextBoldIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  TextUnderlineIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { useEffect, useImperativeHandle, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { FULL_NAME, formatName, type NamePref } from "../lib/display-name"
import { pickFiles } from "../lib/image-attach"
import { filterRoster, mentionQuery } from "../lib/mention"
import { enterKeyAction, type OutgoingMessage, outgoingFromEditor } from "../lib/rich-compose"
import { fetchRoster, type RosterMember } from "../lib/teams-client"

/** Imperative API thread-view drives: focus after a send / on thread open (t159). */
export interface ComposerHandle {
  focus: () => void
  /** Open the native file picker (the hidden <input type="file"> click). */
  openFilePicker: () => void
}

interface ComposerProps {
  ref?: React.Ref<ComposerHandle>
  /** Clears the editor + staged file when it changes (the conversation switch). */
  resetKey: string
  /** Fires the send. Never blocks the editor — the parent appends an optimistic bubble (t159).
   *  `files` are the staged attachments (their captions ride `out.text`). */
  onSend: (out: OutgoingMessage, files: File[]) => void
  /** Mirrors focus into thread-view's composerFocusedRef so bare-key shortcuts stay suppressed. */
  onFocusChange: (focused: boolean) => void
  /** Auto-focus on mount / reset — wide pointer layouts only (a phone would pop the keyboard). */
  autoFocus?: boolean
  /** Stacked quoted-message chips above the editor (PSN-92 B/C); each ✕ drops one, Escape clears all. */
  quotes?: { id: string; authorName: string; preview: string; onCancel: () => void }[]
  /** Escape in the editor — clears the reply targets (only wired when `quotes` is non-empty). */
  onEscape?: () => void
  /** The conversation id — drives the @-mention roster fetch (PSN-92 D). */
  convId?: string
  /** Name display preference (t161) — the visible text of a mention pill respects it. */
  namePref?: NamePref
}

// Formatting toolbar actions → document.execCommand. Deprecated but universal, zero-dep — the lazy
// rung for bold/italic/lists in a contenteditable; revisit only if a browser actually drops it.
const FORMAT_ACTIONS: readonly { cmd: string; icon: IconSvgElement; label: string }[] = [
  { cmd: "bold", icon: TextBoldIcon, label: "Bold (⌘B)" },
  { cmd: "italic", icon: TextItalicIcon, label: "Italic (⌘I)" },
  { cmd: "underline", icon: TextUnderlineIcon, label: "Underline (⌘U)" },
  { cmd: "strikeThrough", icon: TextStrikethroughIcon, label: "Strikethrough" },
  { cmd: "insertUnorderedList", icon: LeftToRightListBulletIcon, label: "Bulleted list" },
  { cmd: "insertOrderedList", icon: LeftToRightListNumberIcon, label: "Numbered list" },
]

/** Per-file chip in the pending-attachments row. Image files show a thumbnail; others show a name
 *  chip. The ✕ button removes this file from the list without moving focus away from the editor. */
function PendingFileChip({ file, onRemove }: { file: File; onRemove: () => void }) {
  const isImage = file.type.startsWith("image/")
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!isImage) return
    const u = URL.createObjectURL(file)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file, isImage])

  return (
    <div className="relative inline-block">
      {isImage && url ? (
        <img
          alt={file.name || "attachment"}
          className="size-16 rounded-lg border border-border object-cover"
          src={url}
        />
      ) : (
        <div className="flex max-w-[16rem] items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <HugeiconsIcon className="size-4 shrink-0 text-muted-foreground" icon={File01Icon} />
          <span className="truncate text-sm">{file.name || "file"}</span>
        </div>
      )}
      <button
        aria-label="Remove attachment"
        className="-right-1.5 -top-1.5 absolute flex size-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm hover:bg-accent"
        onClick={onRemove}
        type="button"
      >
        <HugeiconsIcon className="size-3" icon={Cancel01Icon} />
      </button>
    </div>
  )
}

/** The thread composer (t159): a rich contenteditable in a raised card. Sending never disables the
 *  editor — the parent owns the optimistic bubble lifecycle; this clears itself and refocuses so the
 *  next message can start immediately. Enter sends, Shift+Enter breaks a line, paste is
 *  plain-text-forced (an image paste stages an attachment instead). */
export function Composer({
  ref,
  resetKey,
  onSend,
  onFocusChange,
  autoFocus = false,
  quotes,
  onEscape,
  convId,
  namePref = FULL_NAME,
}: ComposerProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [hasContent, setHasContent] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])

  // @-mention autocomplete (PSN-92 D): the roster is lazy-loaded on the first `@`; `menu` holds the
  // open dropdown's filtered candidates + the highlighted index.
  const roster = useRef<RosterMember[]>([])
  const rosterLoaded = useRef(false)
  const [menu, setMenu] = useState<{ items: RosterMember[]; active: number } | null>(null)

  useImperativeHandle(
    ref,
    () => ({
      focus: () => editorRef.current?.focus(),
      openFilePicker: () => fileRef.current?.click(),
    }),
    [],
  )

  // Reset on conversation switch (a half-typed draft / staged file doesn't leak across panes).
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the deliberate reset trigger
  useEffect(() => {
    const el = editorRef.current
    if (el) el.innerHTML = ""
    setHasContent(false)
    setPendingFiles([])
    setMenu(null)
    roster.current = []
    rosterLoaded.current = false
    if (autoFocus) el?.focus()
  }, [resetKey])

  // The plain text of the current text node up to the caret — enough to spot an `@query` (a query
  // never spans a whitespace, so it stays inside one text node).
  const textBeforeCaret = (): string => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return ""
    const { startContainer, startOffset } = sel.getRangeAt(0)
    return (startContainer.textContent ?? "").slice(0, startOffset)
  }

  // Recompute the mention dropdown from the caret. Lazy-loads the roster on the first `@`.
  const syncMentionMenu = () => {
    const q = mentionQuery(textBeforeCaret())
    if (!q) {
      setMenu(null)
      return
    }
    if (!rosterLoaded.current) {
      rosterLoaded.current = true
      if (convId)
        fetchRoster(convId).then((members) => {
          roster.current = members
          // Re-filter with whatever the caret query is now (the user may have typed on).
          const cur = mentionQuery(textBeforeCaret())
          if (cur) setMenu({ items: filterRoster(members, cur.query), active: 0 })
        })
    }
    setMenu({ items: filterRoster(roster.current, q.query), active: 0 })
  }

  // Replace the typed `@query` with a non-editable mention pill + a trailing space.
  const insertMention = (m: RosterMember) => {
    const el = editorRef.current
    const sel = window.getSelection()
    if (!el || !sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    const node = range.startContainer
    const offset = range.startOffset
    const q = mentionQuery((node.textContent ?? "").slice(0, offset))
    if (!q) return
    const del = document.createRange()
    del.setStart(node, q.at)
    del.setEnd(node, offset)
    del.deleteContents()

    const pill = document.createElement("span")
    // Self mention → coral (mention-self); anyone else → neutral, matching the message bubble.
    pill.className = m.self ? "mention mention-self" : "mention"
    pill.setAttribute("data-mri", m.mri)
    pill.setAttribute("data-name", m.name)
    pill.setAttribute("contenteditable", "false")
    pill.textContent = `@${formatName(m.name, namePref)}`
    del.insertNode(pill)
    const space = document.createTextNode(" ")
    pill.after(space)

    const after = document.createRange()
    after.setStartAfter(space)
    after.collapse(true)
    sel.removeAllRanges()
    sel.addRange(after)

    setMenu(null)
    setHasContent(!!readEditor().text)
  }

  const readEditor = (): OutgoingMessage => outgoingFromEditor(editorRef.current?.innerHTML ?? "")

  const doSend = () => {
    const out = readEditor()
    if (!out.text && pendingFiles.length === 0) return
    onSend(out, pendingFiles)
    const el = editorRef.current
    if (el) el.innerHTML = ""
    setHasContent(false)
    setPendingFiles([])
    // Keep typing: focus never leaves the composer across a send (t159).
    el?.focus()
  }

  const exec = (cmd: string) => {
    editorRef.current?.focus()
    document.execCommand(cmd)
    setHasContent(!!outgoingFromEditor(editorRef.current?.innerHTML ?? "").text)
  }

  const canSend = hasContent || pendingFiles.length > 0

  // Is the caret inside a list item of THIS editor? Then Enter must add/exit a bullet (native), not
  // send — otherwise a list can't grow past one item (PSN-92).
  const caretInListItem = (): boolean => {
    const sel = window.getSelection()
    const node = sel?.anchorNode
    const el = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null
    const li = el?.closest("li") ?? null
    return !!li && !!editorRef.current?.contains(li)
  }

  return (
    <div className="shrink-0 px-3 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div
        className={cn(
          "relative rounded-2xl border border-input bg-card shadow-sm transition-shadow",
          "focus-within:border-ring/40 focus-within:shadow-md focus-within:ring-2 focus-within:ring-ring/25",
        )}
      >
        {menu && menu.items.length > 0 && (
          <div className="absolute bottom-full left-2 z-50 mb-1 max-h-60 w-64 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-md">
            {menu.items.map((m, i) => (
              <button
                className={cn(
                  "flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm",
                  i === menu.active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                )}
                // Keep the editor selection: a mousedown would blur + collapse it before the click.
                key={m.mri}
                onClick={() => insertMention(m)}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setMenu((cur) => cur && { ...cur, active: i })}
                type="button"
              >
                <span className="truncate">{formatName(m.name, namePref)}</span>
              </button>
            ))}
          </div>
        )}
        {quotes && quotes.length > 0 && (
          <div className="flex flex-col items-start gap-1 px-3 pt-3">
            {quotes.map((q) => (
              <div
                className="flex w-fit max-w-full items-start gap-2 rounded-lg border-ring/30 border-l-2 bg-muted/40 py-1.5 pr-1.5 pl-2.5"
                key={q.id}
              >
                <div className="min-w-0 max-w-[20rem]">
                  <div className="truncate font-medium text-ring text-xs">{q.authorName}</div>
                  <div className="truncate text-muted-foreground text-xs">{q.preview}</div>
                </div>
                <button
                  aria-label="Remove quoted message"
                  className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent"
                  onClick={() => {
                    q.onCancel()
                    editorRef.current?.focus()
                  }}
                  type="button"
                >
                  <HugeiconsIcon className="size-3" icon={Cancel01Icon} />
                </button>
              </div>
            ))}
          </div>
        )}
        {pendingFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {pendingFiles.map((file) => (
              <PendingFileChip
                file={file}
                key={`${file.name}-${file.size}-${file.lastModified}`}
                onRemove={() => {
                  // Remove by reference: a user can add the same filename twice (different objects);
                  // remove only the first matching identity so the other stays.
                  setPendingFiles((cur) => {
                    const i = cur.indexOf(file)
                    return i === -1 ? cur : [...cur.slice(0, i), ...cur.slice(i + 1)]
                  })
                  editorRef.current?.focus()
                }}
              />
            ))}
          </div>
        )}
        {/* biome-ignore lint/a11y/useSemanticElements: a rich-text editor is a contenteditable div */}
        <div
          aria-label="Message"
          aria-multiline="true"
          className={cn(
            "composer-editor max-h-40 min-h-[2.5rem] overflow-y-auto px-3.5 py-2.5 text-base outline-none",
            "empty:before:pointer-events-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]",
          )}
          contentEditable
          data-placeholder="Type a message…"
          onBlur={() => onFocusChange(false)}
          onFocus={() => onFocusChange(true)}
          onInput={() => {
            setHasContent(!!readEditor().text)
            syncMentionMenu()
          }}
          onKeyDown={(e) => {
            // Mention dropdown steals the nav/commit keys while open (PSN-92 D).
            if (menu && menu.items.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault()
                setMenu((m) => m && { ...m, active: (m.active + 1) % m.items.length })
                return
              }
              if (e.key === "ArrowUp") {
                e.preventDefault()
                setMenu(
                  (m) => m && { ...m, active: (m.active - 1 + m.items.length) % m.items.length },
                )
                return
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault()
                insertMention(menu.items[menu.active])
                return
              }
              if (e.key === "Escape") {
                e.preventDefault()
                setMenu(null)
                return
              }
            }
            if (e.key === "Enter") {
              const action = enterKeyAction({
                shift: e.shiftKey,
                meta: e.metaKey || e.ctrlKey,
                inListItem: caretInListItem(),
              })
              if (action === "send") {
                e.preventDefault()
                doSend()
              }
              // "default" → the browser adds/exits a list item or inserts a soft break.
            } else if (e.key === "Escape" && quotes && quotes.length > 0) {
              e.preventDefault()
              onEscape?.()
              editorRef.current?.focus()
            }
          }}
          onPaste={(e) => {
            const pasted = pickFiles(e.clipboardData?.items)
            if (pasted.length > 0) {
              e.preventDefault()
              setPendingFiles((cur) => [...cur, ...pasted])
              return
            }
            // Plain-text-forced paste: outside HTML never enters the editor (formatting stays ours).
            e.preventDefault()
            const text = e.clipboardData?.getData("text/plain") ?? ""
            if (text) document.execCommand("insertText", false, text)
            setHasContent(!!readEditor().text)
          }}
          ref={editorRef}
          role="textbox"
          tabIndex={0}
        />
        <div className="flex items-center gap-0.5 px-2 pb-2">
          <input
            className="hidden"
            multiple
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? [])
              if (picked.length > 0) setPendingFiles((cur) => [...cur, ...picked])
              e.target.value = "" // allow re-picking the same file
            }}
            ref={fileRef}
            type="file"
          />
          <Button
            aria-label="Attach file"
            className="text-muted-foreground"
            onClick={() => fileRef.current?.click()}
            size="icon-sm"
            variant="ghost"
          >
            <HugeiconsIcon className="size-4" icon={Attachment01Icon} />
          </Button>
          <div className="mx-1 h-4 w-px bg-border" />
          {FORMAT_ACTIONS.map((a) => (
            <Button
              aria-label={a.label}
              className="text-muted-foreground"
              key={a.cmd}
              onClick={() => exec(a.cmd)}
              // Keep the editor selection: a mousedown on a button would blur + collapse it.
              onMouseDown={(e) => e.preventDefault()}
              size="icon-sm"
              title={a.label}
              variant="ghost"
            >
              <HugeiconsIcon className="size-4" icon={a.icon} />
            </Button>
          ))}
          <div className="flex-1" />
          <Button
            aria-label="Send"
            className="rounded-full"
            disabled={!canSend}
            onClick={doSend}
            size="icon-sm"
          >
            <HugeiconsIcon className="size-4" icon={ArrowUp01Icon} />
          </Button>
        </div>
      </div>
    </div>
  )
}
