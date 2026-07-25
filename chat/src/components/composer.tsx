import {
  ArrowUp01Icon,
  Attachment01Icon,
  Cancel01Icon,
  CodeIcon,
  File01Icon,
  GifIcon,
  LeftToRightListBulletIcon,
  LeftToRightListNumberIcon,
  Link01Icon,
  QuoteUpIcon,
  SmileIcon,
  SourceCodeIcon,
  StickerIcon,
  TextBoldIcon,
  TextClearIcon,
  TextFontIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  TextUnderlineIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { useEffect, useImperativeHandle, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { fetchRoster } from "../lib/chat-client"
import { FULL_NAME, formatName, type NamePref } from "../lib/display-name"
import { pickFiles } from "../lib/image-attach"
import {
  type BlockMatch,
  type InlineMatch,
  matchBlockShortcut,
  matchInlineShortcut,
} from "../lib/markdown-shortcuts"
import { filterRoster, mentionQuery } from "../lib/mention"
import { enterKeyAction, type OutgoingMessage, outgoingFromEditor } from "../lib/rich-compose"
import type { RosterMember } from "../lib/teams-client"
import { useEmojiCatalog } from "../lib/use-emoji-catalog"
import { EmojiPicker } from "./emoji-picker"
import { prompt } from "./prompt-dialog"

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

/** Below which composer-card width the formatting actions collapse behind the Format (Aa) toggle
 *  instead of sitting inline (PSN-94 A — width-responsive action bar). */
const FORMAT_INLINE_MIN_WIDTH = 480

// A tooltip-only info line so the info doesn't spill: title lives on each button.
function FmtButton({
  icon,
  label,
  onRun,
}: {
  icon: IconSvgElement
  label: string
  onRun: () => void
}) {
  return (
    <Button
      aria-label={label}
      className="text-muted-foreground"
      onClick={onRun}
      // Keep the editor selection: a mousedown on a button would blur + collapse it.
      onMouseDown={(e) => e.preventDefault()}
      size="icon-sm"
      title={label}
      variant="ghost"
    >
      <HugeiconsIcon className="size-4" icon={icon} />
    </Button>
  )
}

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
  const cardRef = useRef<HTMLDivElement>(null)
  const [hasContent, setHasContent] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])

  // Width-responsive action bar (PSN-94 A): format actions sit inline when the card is wide, else
  // collapse behind the Format toggle.
  const [wide, setWide] = useState(true)
  const [formatOpen, setFormatOpen] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const catalog = useEmojiCatalog()

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

  // Track the card width so the bar knows when to inline the format row.
  useEffect(() => {
    const el = cardRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      if (w) setWide(w >= FORMAT_INLINE_MIN_WIDTH)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Reset on conversation switch (a half-typed draft / staged file doesn't leak across panes).
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the deliberate reset trigger
  useEffect(() => {
    const el = editorRef.current
    if (el) el.innerHTML = ""
    setHasContent(false)
    setPendingFiles([])
    setMenu(null)
    setEmojiOpen(false)
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
    const space = document.createTextNode(" ")
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

  const syncHasContent = () => setHasContent(!!readEditor().text)

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

  // --- Formatting actions (PSN-94 A) ---------------------------------------
  // execCommand is deprecated but universal + zero-dep — the lazy rung for a contenteditable. The
  // render side has its own DOMPurify boundary; cleanEditorHtml keeps only the allowlisted tags.

  const exec = (cmd: string) => {
    editorRef.current?.focus()
    document.execCommand(cmd)
    syncHasContent()
  }

  // formatBlock wraps the caret's block in a tag (blockquote / pre). Toggling back to a plain block
  // isn't offered — clear-formatting flattens everything.
  const execBlock = (tag: string) => {
    editorRef.current?.focus()
    document.execCommand("formatBlock", false, tag)
    syncHasContent()
  }

  // Inline code has no execCommand — wrap the selection in <code> by hand.
  const wrapInlineCode = () => {
    const el = editorRef.current
    el?.focus()
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    if (range.collapsed) return
    const code = document.createElement("code")
    try {
      range.surroundContents(code)
    } catch {
      // Selection crosses element boundaries — extract + re-insert instead.
      code.appendChild(range.extractContents())
      range.insertNode(code)
    }
    const after = document.createRange()
    after.setStartAfter(code)
    after.collapse(true)
    sel.removeAllRanges()
    sel.addRange(after)
    syncHasContent()
  }

  // Insert-link: prompt for a URL, then link the saved selection (a collapsed caret inserts the URL
  // as its own link text, matching Teams). The dialog steals focus, so the range is captured first
  // and restored before createLink runs.
  const insertLink = async () => {
    const sel = window.getSelection()
    const saved = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null
    const url = (await prompt({ title: "Insert link", placeholder: "https://…" }))?.trim()
    if (!url) return
    editorRef.current?.focus()
    if (saved) {
      const s = window.getSelection()
      s?.removeAllRanges()
      s?.addRange(saved)
    }
    if (saved && !saved.collapsed) {
      document.execCommand("createLink", false, url)
    } else {
      const safe = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
      document.execCommand("insertHTML", false, `<a href="${safe}">${safe}</a>`)
    }
    syncHasContent()
  }

  // Clear-formatting: strip inline marks (bold/italic/underline/strike/link) and flatten the block
  // (drops code block / quote / list wrapping). removeFormat leaves the text intact.
  const clearFormat = () => {
    editorRef.current?.focus()
    document.execCommand("removeFormat")
    document.execCommand("unlink")
    document.execCommand("formatBlock", false, "div")
    syncHasContent()
  }

  const insertEmoji = (key: string) => {
    setEmojiOpen(false)
    const u = catalog?.emoji.find((e) => e.i === key)?.u
    editorRef.current?.focus()
    if (u) document.execCommand("insertText", false, u)
    syncHasContent()
  }

  // --- Live markdown auto-convert (PSN-94 B) --------------------------------
  // Run on every input: if the text before a collapsed caret just completed a markdown span/prefix,
  // replace the source with the formatted node. Pure detection lives in markdown-shortcuts.ts.

  // A text node sits at the start of its line when nothing precedes it, or only a <br> does.
  const isLineStart = (node: Node): boolean => {
    const prev = node.previousSibling
    return !prev || prev.nodeName === "BR"
  }

  const applyBlockMarkdown = (node: Text, block: BlockMatch) => {
    const sel = window.getSelection()
    if (!sel) return
    const strip = document.createRange()
    strip.setStart(node, 0)
    strip.setEnd(node, block.raw.length)
    strip.deleteContents()
    const caret = document.createRange()
    caret.setStart(node, 0)
    caret.collapse(true)
    sel.removeAllRanges()
    sel.addRange(caret)
    editorRef.current?.focus()
    if (block.kind === "quote") document.execCommand("formatBlock", false, "blockquote")
    else if (block.kind === "code") document.execCommand("formatBlock", false, "pre")
    else if (block.kind === "ul") document.execCommand("insertUnorderedList")
    else if (block.kind === "ol") document.execCommand("insertOrderedList")
    syncHasContent()
  }

  const applyInlineMarkdown = (node: Text, caretOffset: number, m: InlineMatch) => {
    const sel = window.getSelection()
    if (!sel) return
    const range = document.createRange()
    range.setStart(node, m.start)
    range.setEnd(node, caretOffset)
    range.deleteContents()
    const wrap = document.createElement(m.tag)
    wrap.textContent = m.inner
    range.insertNode(wrap)
    // Caret lands after the mark so continued typing stays unformatted.
    const after = document.createRange()
    after.setStartAfter(wrap)
    after.collapse(true)
    sel.removeAllRanges()
    sel.addRange(after)
    syncHasContent()
  }

  const applyMarkdown = () => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    if (!range.collapsed) return
    const node = range.startContainer
    if (node.nodeType !== Node.TEXT_NODE) return
    // Never reformat inside an existing code span/block.
    if ((node.parentElement as Element | null)?.closest("code, pre")) return
    const offset = range.startOffset
    const text = (node.textContent ?? "").slice(0, offset)

    const block = matchBlockShortcut(text)
    if (block && isLineStart(node)) {
      applyBlockMarkdown(node as Text, block)
      return
    }
    const inline = matchInlineShortcut(text)
    if (inline) applyInlineMarkdown(node as Text, offset, inline)
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

  // The formatting cluster — rendered inline when wide, or in a collapsible row when narrow.
  const formatButtons = (
    <>
      <FmtButton icon={TextBoldIcon} label="Bold (⌘B)" onRun={() => exec("bold")} />
      <FmtButton icon={TextItalicIcon} label="Italic (⌘I)" onRun={() => exec("italic")} />
      <FmtButton icon={TextUnderlineIcon} label="Underline (⌘U)" onRun={() => exec("underline")} />
      <FmtButton
        icon={TextStrikethroughIcon}
        label="Strikethrough"
        onRun={() => exec("strikeThrough")}
      />
      <div className="mx-1 h-4 w-px bg-border" />
      <FmtButton icon={CodeIcon} label="Inline code" onRun={wrapInlineCode} />
      <FmtButton icon={SourceCodeIcon} label="Code block" onRun={() => execBlock("pre")} />
      <FmtButton icon={QuoteUpIcon} label="Quote" onRun={() => execBlock("blockquote")} />
      <div className="mx-1 h-4 w-px bg-border" />
      <FmtButton
        icon={LeftToRightListBulletIcon}
        label="Bulleted list"
        onRun={() => exec("insertUnorderedList")}
      />
      <FmtButton
        icon={LeftToRightListNumberIcon}
        label="Numbered list"
        onRun={() => exec("insertOrderedList")}
      />
      <div className="mx-1 h-4 w-px bg-border" />
      <FmtButton icon={Link01Icon} label="Insert link" onRun={insertLink} />
      <FmtButton icon={TextClearIcon} label="Clear formatting" onRun={clearFormat} />
    </>
  )

  return (
    <div className="shrink-0 px-3 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div
        className={cn(
          "relative rounded-2xl border border-input bg-card shadow-sm transition-shadow",
          "focus-within:border-ring/40 focus-within:shadow-md focus-within:ring-2 focus-within:ring-ring/25",
        )}
        ref={cardRef}
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
            applyMarkdown()
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
        {/* Narrow layout: the formatting row lives above the bar and toggles open. */}
        {!wide && formatOpen && (
          <div className="flex flex-wrap items-center gap-0.5 px-2 pb-1">{formatButtons}</div>
        )}
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
            title="Attach file"
            variant="ghost"
          >
            <HugeiconsIcon className="size-4" icon={Attachment01Icon} />
          </Button>
          <div className="relative">
            <Button
              aria-label="Emoji"
              className={cn("text-muted-foreground", emojiOpen && "bg-accent text-foreground")}
              onClick={() => setEmojiOpen((v) => !v)}
              onMouseDown={(e) => e.preventDefault()}
              size="icon-sm"
              title="Emoji"
              variant="ghost"
            >
              <HugeiconsIcon className="size-4" icon={SmileIcon} />
            </Button>
            {emojiOpen && (
              <>
                {/* biome-ignore lint/a11y/noStaticElementInteractions: click-away dismiss backdrop */}
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setEmojiOpen(false)}
                  onKeyDown={(e) => e.key === "Escape" && setEmojiOpen(false)}
                />
                <div className="absolute bottom-full left-0 z-50 mb-1 rounded-xl border border-border bg-popover shadow-lg">
                  <EmojiPicker onClose={() => setEmojiOpen(false)} onSelect={insertEmoji} />
                </div>
              </>
            )}
          </div>
          {/* GIF + sticker land in workstreams D + E — placeholders reserve the slot. */}
          <Button
            aria-label="GIF (coming soon)"
            className="text-muted-foreground"
            disabled
            size="icon-sm"
            title="GIF (coming soon)"
            variant="ghost"
          >
            <HugeiconsIcon className="size-4" icon={GifIcon} />
          </Button>
          <Button
            aria-label="Sticker (coming soon)"
            className="text-muted-foreground"
            disabled
            size="icon-sm"
            title="Sticker (coming soon)"
            variant="ghost"
          >
            <HugeiconsIcon className="size-4" icon={StickerIcon} />
          </Button>
          {wide ? (
            <>
              <div className="mx-1 h-4 w-px bg-border" />
              {formatButtons}
            </>
          ) : (
            <Button
              aria-label="Formatting"
              className={cn("text-muted-foreground", formatOpen && "bg-accent text-foreground")}
              onClick={() => setFormatOpen((v) => !v)}
              size="icon-sm"
              title="Formatting"
              variant="ghost"
            >
              <HugeiconsIcon className="size-4" icon={TextFontIcon} />
            </Button>
          )}
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
