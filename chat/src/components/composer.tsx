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
import Mention from "@tiptap/extension-mention"
import { type Editor, EditorContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { useEffect, useImperativeHandle, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { fetchRoster } from "../lib/chat-client"
import { FULL_NAME, formatName, type NamePref } from "../lib/display-name"
import { pickFiles } from "../lib/image-attach"
import { filterRoster } from "../lib/mention"
import { type OutgoingMessage, outgoingFromEditor } from "../lib/rich-compose"
import type { RosterMember } from "../lib/teams-client"
import { type GifItem, type GiphyKind, gifToOutgoing } from "../lib/teams-gif"
import { useEmojiCatalog } from "../lib/use-emoji-catalog"
import { EmojiPicker } from "./emoji-picker"
import { GifPicker } from "./gif-picker"
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

// A ghost icon button with a shadcn Tooltip (replaces the native `title`, PSN-94). The mousedown
// preventDefault keeps the editor selection so the action lands on it.
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
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className="text-muted-foreground"
          onClick={onRun}
          onMouseDown={(e) => e.preventDefault()}
          size="icon-sm"
          variant="ghost"
        >
          <HugeiconsIcon className="size-4" icon={icon} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

// The toggleable inline marks — a shadcn ToggleGroup that highlights whichever are active at the
// caret via Tiptap's editor.isActive (PSN-94 — the "format UX isn't good" note).
const MARKS: { v: string; icon: IconSvgElement; label: string }[] = [
  { v: "bold", icon: TextBoldIcon, label: "Bold (⌘B)" },
  { v: "italic", icon: TextItalicIcon, label: "Italic (⌘I)" },
  { v: "underline", icon: TextUnderlineIcon, label: "Underline (⌘U)" },
  { v: "strike", icon: TextStrikethroughIcon, label: "Strikethrough" },
]

// The @-mention node emits the SAME pill markup the existing send-shaper expects
// (`outgoingFromEditor` reads `data-mri`/`data-name`), so the Teams per-token wire mapping is
// unchanged — Tiptap just replaces the contenteditable that produced those pills (PSN-94).
const RosterMention = Mention.extend({
  addAttributes() {
    return {
      id: { default: null },
      label: { default: null },
      self: { default: false },
    }
  },
  renderHTML({ node }) {
    return [
      "span",
      {
        class: node.attrs.self ? "mention mention-self" : "mention",
        "data-mri": node.attrs.id ?? "",
        "data-name": node.attrs.label ?? "",
      },
      `@${node.attrs.label ?? ""}`,
    ]
  },
})

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

// The live suggestion dropdown state, driven by Tiptap's Mention suggestion plugin.
interface MentionState {
  items: RosterMember[]
  active: number
  left: number
  top: number
}

/** The thread composer (PSN-94): a Tiptap rich editor. Markdown input rules (`**b**`, `` `c` ``,
 *  `> `, `- `, `1. `, ```` ``` ````) convert live with no caret bleed (ProseMirror mark model), the
 *  toolbar reflects the caret's active marks, and @-mentions ride the Mention extension. Sending
 *  never disables the editor — the parent owns the optimistic bubble; this clears + refocuses.
 *  Enter sends, Shift+Enter is a soft break, ⌘/Ctrl+Enter always sends; inside a list or code block
 *  Enter keeps its native behaviour. A picked GIF/emoji/file is handled outside the editor. */
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
  const fileRef = useRef<HTMLInputElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const [hasContent, setHasContent] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [wide, setWide] = useState(true)
  const [formatOpen, setFormatOpen] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [gifKind, setGifKind] = useState<GiphyKind | null>(null)
  const [mention, setMention] = useState<MentionState | null>(null)
  // Re-render tick so the toolbar's active-mark highlights refresh on every selection/content change.
  const [, setTick] = useState(0)
  const catalog = useEmojiCatalog()

  // Refs that the Tiptap editorProps handlers (created once) read live.
  const doSendRef = useRef<() => void>(() => {})
  const quotesRef = useRef(quotes)
  quotesRef.current = quotes
  const onEscapeRef = useRef(onEscape)
  onEscapeRef.current = onEscape
  const mentionOpenRef = useRef(false)
  // The current suggestion command + active index, so onKeyDown can commit without stale state.
  const suggestRef = useRef<{
    command?: (a: { id: string; label: string; self: boolean }) => void
    items: RosterMember[]
    active: number
  }>({ items: [], active: 0 })

  // Roster, lazy-loaded once per conversation on the first `@`.
  const rosterRef = useRef<RosterMember[] | null>(null)
  const loadRoster = async (): Promise<RosterMember[]> => {
    if (rosterRef.current) return rosterRef.current
    const members = convId ? await fetchRoster(convId) : []
    rosterRef.current = members
    return members
  }

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: {
          openOnClick: false,
          autolink: true,
          HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" },
        },
      }),
      RosterMention.configure({
        suggestion: {
          char: "@",
          items: async ({ query }) => filterRoster(await loadRoster(), query),
          command: ({ editor, range, props }) => {
            // props carries our chosen member (id/label/self); insert the mention node + a space.
            editor
              .chain()
              .focus()
              .insertContentAt(range, [
                { type: "mention", attrs: props },
                { type: "text", text: " " },
              ])
              .run()
          },
          render: () => ({
            onStart: (props) => {
              mentionOpenRef.current = true
              suggestRef.current = {
                command: props.command as (a: { id: string; label: string; self: boolean }) => void,
                items: props.items,
                active: 0,
              }
              const r = props.clientRect?.()
              setMention({ items: props.items, active: 0, left: r?.left ?? 0, top: r?.top ?? 0 })
            },
            onUpdate: (props) => {
              suggestRef.current.items = props.items
              suggestRef.current.command = props.command as (a: {
                id: string
                label: string
                self: boolean
              }) => void
              const r = props.clientRect?.()
              setMention((m) =>
                m
                  ? { ...m, items: props.items, active: 0, left: r?.left ?? 0, top: r?.top ?? 0 }
                  : m,
              )
              suggestRef.current.active = 0
            },
            onKeyDown: (props) => {
              const key = props.event.key
              const { items } = suggestRef.current
              if (!items.length) return false
              if (key === "ArrowDown") {
                const a = (suggestRef.current.active + 1) % items.length
                suggestRef.current.active = a
                setMention((m) => m && { ...m, active: a })
                return true
              }
              if (key === "ArrowUp") {
                const a = (suggestRef.current.active - 1 + items.length) % items.length
                suggestRef.current.active = a
                setMention((m) => m && { ...m, active: a })
                return true
              }
              if (key === "Enter" || key === "Tab") {
                commitMention(suggestRef.current.active)
                return true
              }
              if (key === "Escape") {
                setMention(null)
                return true
              }
              return false
            },
            onExit: () => {
              mentionOpenRef.current = false
              setMention(null)
            },
          }),
        },
      }),
    ],
    autofocus: autoFocus,
    editorProps: {
      attributes: {
        class:
          "composer-editor max-h-40 min-h-[2.5rem] overflow-y-auto px-3.5 py-2.5 text-base outline-none",
        "aria-label": "Message",
        "aria-multiline": "true",
        role: "textbox",
      },
      handleKeyDown: (_view, event) => {
        if (event.key === "Escape" && quotesRef.current && quotesRef.current.length > 0) {
          event.preventDefault()
          onEscapeRef.current?.()
          return true
        }
        if (event.key !== "Enter") return false
        // The mention suggestion owns Enter while open.
        if (mentionOpenRef.current) return false
        if (event.shiftKey) return false // soft line break (hardBreak)
        if (event.metaKey || event.ctrlKey) {
          doSendRef.current()
          return true
        }
        // Inside a list / code block, Enter keeps its native behaviour (new item / newline).
        const ed = edRef.current
        if (ed?.isActive("listItem") || ed?.isActive("codeBlock")) return false
        doSendRef.current()
        return true
      },
      handlePaste: (_view, event) => {
        const pasted = pickFiles(event.clipboardData?.items)
        if (pasted.length > 0) {
          setPendingFiles((cur) => [...cur, ...pasted])
          return true
        }
        return false
      },
    },
    onUpdate: ({ editor }) => {
      setHasContent(!editor.isEmpty)
      setTick((t) => t + 1)
    },
    onSelectionUpdate: () => setTick((t) => t + 1),
    onFocus: () => onFocusChange(true),
    onBlur: () => onFocusChange(false),
  })

  // A ref to the editor for the editorProps handlers (created before `editor` is assigned).
  const edRef = useRef<Editor | null>(null)
  edRef.current = editor

  const commitMention = (index: number) => {
    const { command, items } = suggestRef.current
    const m = items[index]
    if (command && m) command({ id: m.mri, label: m.name, self: !!m.self })
    setMention(null)
  }

  useImperativeHandle(
    ref,
    () => ({
      focus: () => editor?.commands.focus(),
      openFilePicker: () => fileRef.current?.click(),
    }),
    [editor],
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
    editor?.commands.clearContent()
    setHasContent(false)
    setPendingFiles([])
    setEmojiOpen(false)
    setGifKind(null)
    setMention(null)
    rosterRef.current = null
    if (autoFocus) editor?.commands.focus()
  }, [resetKey, editor])

  const readEditor = (): OutgoingMessage => outgoingFromEditor(editor?.getHTML() ?? "")

  const doSend = () => {
    const out = readEditor()
    if (!out.text && pendingFiles.length === 0) return
    onSend(out, pendingFiles)
    editor?.commands.clearContent()
    setHasContent(false)
    setPendingFiles([])
    editor?.commands.focus()
  }
  doSendRef.current = doSend

  // --- Formatting actions via Tiptap commands -------------------------------
  const focusChain = () => editor?.chain().focus()
  const insertLink = async () => {
    const prev = editor?.getAttributes("link").href ?? ""
    const url = (
      await prompt({ title: "Insert link", initialValue: prev, placeholder: "https://…" })
    )?.trim()
    if (url === undefined || url === null) return
    if (url === "") {
      focusChain()?.extendMarkRange("link").unsetLink().run()
      return
    }
    focusChain()?.extendMarkRange("link").setLink({ href: url }).run()
  }
  const clearFormat = () => focusChain()?.unsetAllMarks().clearNodes().run()

  const insertEmoji = (key: string) => {
    setEmojiOpen(false)
    const u = catalog?.emoji.find((e) => e.i === key)?.u
    if (u) editor?.chain().focus().insertContent(u).run()
  }

  const sendGif = (item: GifItem) => {
    setGifKind(null)
    onSend(gifToOutgoing(item), [])
    editor?.commands.focus()
  }

  const onMarksChange = (next: string[]) => {
    const toggled = MARKS.map((m) => m.v).find(
      (v) => next.includes(v) !== !!editor?.isActive(v === "strike" ? "strike" : v),
    )
    if (!toggled || !editor) return
    const c = editor.chain().focus()
    if (toggled === "bold") c.toggleBold().run()
    else if (toggled === "italic") c.toggleItalic().run()
    else if (toggled === "underline") c.toggleUnderline().run()
    else if (toggled === "strike") c.toggleStrike().run()
  }

  const activeMarks = editor ? MARKS.filter((m) => editor.isActive(m.v)).map((m) => m.v) : []
  const canSend = hasContent || pendingFiles.length > 0

  // The formatting cluster — inline when wide, or in a collapsible row when narrow.
  const formatButtons = (
    <>
      <ToggleGroup
        className="gap-0.5"
        onValueChange={onMarksChange}
        size="sm"
        type="multiple"
        value={activeMarks}
      >
        {MARKS.map((m) => (
          <ToggleGroupItem
            aria-label={m.label}
            className="text-muted-foreground data-[state=on]:bg-accent data-[state=on]:text-foreground"
            key={m.v}
            onMouseDown={(e) => e.preventDefault()}
            value={m.v}
          >
            <HugeiconsIcon className="size-4" icon={m.icon} />
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <div className="mx-1 h-4 w-px bg-border" />
      <FmtButton
        icon={CodeIcon}
        label="Inline code"
        onRun={() => focusChain()?.toggleCode().run()}
      />
      <FmtButton
        icon={SourceCodeIcon}
        label="Code block"
        onRun={() => focusChain()?.toggleCodeBlock().run()}
      />
      <FmtButton
        icon={QuoteUpIcon}
        label="Quote"
        onRun={() => focusChain()?.toggleBlockquote().run()}
      />
      <div className="mx-1 h-4 w-px bg-border" />
      <FmtButton
        icon={LeftToRightListBulletIcon}
        label="Bulleted list"
        onRun={() => focusChain()?.toggleBulletList().run()}
      />
      <FmtButton
        icon={LeftToRightListNumberIcon}
        label="Numbered list"
        onRun={() => focusChain()?.toggleOrderedList().run()}
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
        {mention && mention.items.length > 0 && (
          <div
            className="fixed z-50 max-h-60 w-64 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-md"
            style={{
              left: mention.left,
              top: mention.top,
              transform: "translateY(calc(-100% - 8px))",
            }}
          >
            {mention.items.map((m, i) => (
              <button
                className={cn(
                  "flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm",
                  i === mention.active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                )}
                key={m.mri}
                onClick={() => commitMention(i)}
                onMouseDown={(e) => e.preventDefault()}
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
                    editor?.commands.focus()
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
                  setPendingFiles((cur) => {
                    const i = cur.indexOf(file)
                    return i === -1 ? cur : [...cur.slice(0, i), ...cur.slice(i + 1)]
                  })
                  editor?.commands.focus()
                }}
              />
            ))}
          </div>
        )}
        <EditorContent
          className="[&_.ProseMirror]:min-h-[2.5rem] [&_.ProseMirror_.mention]:font-medium [&_.ProseMirror_.mention]:text-ring [&_.ProseMirror_blockquote]:border-ring/40 [&_.ProseMirror_blockquote]:border-l-2 [&_.ProseMirror_blockquote]:pl-3 [&_.ProseMirror_code]:rounded [&_.ProseMirror_code]:bg-muted [&_.ProseMirror_code]:px-1 [&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ol]:pl-5 [&_.ProseMirror_pre]:rounded-lg [&_.ProseMirror_pre]:bg-muted [&_.ProseMirror_pre]:p-2 [&_.ProseMirror_ul]:list-disc [&_.ProseMirror_ul]:pl-5 [&_.ProseMirror.ProseMirror-focused]:outline-none [&_.ProseMirror[data-placeholder]]:before:text-muted-foreground"
          editor={editor}
        />
        <TooltipProvider delayDuration={300}>
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
                e.target.value = ""
              }}
              ref={fileRef}
              type="file"
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Attach file"
                  className="text-muted-foreground"
                  onClick={() => fileRef.current?.click()}
                  size="icon-sm"
                  variant="ghost"
                >
                  <HugeiconsIcon className="size-4" icon={Attachment01Icon} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Attach file</TooltipContent>
            </Tooltip>
            <div className="relative">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label="Emoji"
                    className={cn(
                      "text-muted-foreground",
                      emojiOpen && "bg-accent text-foreground",
                    )}
                    onClick={() => setEmojiOpen((v) => !v)}
                    onMouseDown={(e) => e.preventDefault()}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <HugeiconsIcon className="size-4" icon={SmileIcon} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Emoji</TooltipContent>
              </Tooltip>
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
            {/* GIF + sticker (PSN-94 D/E): both open one Giphy picker keyed by kind. */}
            <div className="relative">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label="GIF"
                    className={cn(
                      "text-muted-foreground",
                      gifKind === "gifs" && "bg-accent text-foreground",
                    )}
                    onClick={() => setGifKind((k) => (k === "gifs" ? null : "gifs"))}
                    onMouseDown={(e) => e.preventDefault()}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <HugeiconsIcon className="size-4" icon={GifIcon} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>GIF</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label="Sticker"
                    className={cn(
                      "text-muted-foreground",
                      gifKind === "stickers" && "bg-accent text-foreground",
                    )}
                    onClick={() => setGifKind((k) => (k === "stickers" ? null : "stickers"))}
                    onMouseDown={(e) => e.preventDefault()}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <HugeiconsIcon className="size-4" icon={StickerIcon} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Sticker</TooltipContent>
              </Tooltip>
              {gifKind && (
                <>
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: click-away dismiss backdrop */}
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setGifKind(null)}
                    onKeyDown={(e) => e.key === "Escape" && setGifKind(null)}
                  />
                  <div className="absolute bottom-full left-0 z-50 mb-1 rounded-xl border border-border bg-popover shadow-lg">
                    <GifPicker kind={gifKind} onClose={() => setGifKind(null)} onSelect={sendGif} />
                  </div>
                </>
              )}
            </div>
            {wide ? (
              <>
                <div className="mx-1 h-4 w-px bg-border" />
                {formatButtons}
              </>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    aria-label="Formatting"
                    className={cn(
                      "text-muted-foreground",
                      formatOpen && "bg-accent text-foreground",
                    )}
                    onClick={() => setFormatOpen((v) => !v)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <HugeiconsIcon className="size-4" icon={TextFontIcon} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Formatting</TooltipContent>
              </Tooltip>
            )}
            <div className="flex-1" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label="Send"
                  className="rounded-full"
                  disabled={!canSend}
                  onClick={doSend}
                  size="icon-sm"
                >
                  <HugeiconsIcon className="size-4" icon={ArrowUp01Icon} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Send (↵)</TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      </div>
    </div>
  )
}
