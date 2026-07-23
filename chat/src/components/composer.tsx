import {
  Attachment01Icon,
  Cancel01Icon,
  File01Icon,
  LeftToRightListBulletIcon,
  LeftToRightListNumberIcon,
  SentIcon,
  TextBoldIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  TextUnderlineIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { useEffect, useImperativeHandle, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { pickFile } from "../lib/image-attach"
import { type OutgoingMessage, outgoingFromEditor } from "../lib/rich-compose"

/** Imperative API thread-view drives: focus after a send / on thread open (t159). */
export interface ComposerHandle {
  focus: () => void
}

interface ComposerProps {
  ref?: React.Ref<ComposerHandle>
  /** Clears the editor + staged file when it changes (the conversation switch). */
  resetKey: string
  /** Fires the send. Never blocks the editor — the parent appends an optimistic bubble (t159).
   *  `file` is the staged attachment (its caption is `out.text`). */
  onSend: (out: OutgoingMessage, file: File | null) => void
  /** Mirrors focus into thread-view's composerFocusedRef so bare-key shortcuts stay suppressed. */
  onFocusChange: (focused: boolean) => void
  /** Auto-focus on mount / reset — wide pointer layouts only (a phone would pop the keyboard). */
  autoFocus?: boolean
  /** Stacked quoted-message chips above the editor (PSN-92 B/C); each ✕ drops one, Escape clears all. */
  quotes?: { id: string; authorName: string; preview: string; onCancel: () => void }[]
  /** Escape in the editor — clears the reply targets (only wired when `quotes` is non-empty). */
  onEscape?: () => void
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
}: ComposerProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [hasContent, setHasContent] = useState(false)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [pendingUrl, setPendingUrl] = useState<string | null>(null)

  useImperativeHandle(ref, () => ({ focus: () => editorRef.current?.focus() }), [])

  // Reset on conversation switch (a half-typed draft / staged file doesn't leak across panes).
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is the deliberate reset trigger
  useEffect(() => {
    const el = editorRef.current
    if (el) el.innerHTML = ""
    setHasContent(false)
    setPendingFile(null)
    if (autoFocus) el?.focus()
  }, [resetKey])

  // Object-URL thumbnail preview — images only; a non-image file shows a chip, not a thumbnail.
  useEffect(() => {
    if (!pendingFile?.type.startsWith("image/")) {
      setPendingUrl(null)
      return
    }
    const url = URL.createObjectURL(pendingFile)
    setPendingUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [pendingFile])

  const readEditor = (): OutgoingMessage => outgoingFromEditor(editorRef.current?.innerHTML ?? "")

  const doSend = () => {
    const out = readEditor()
    if (!out.text && !pendingFile) return
    onSend(out, pendingFile)
    const el = editorRef.current
    if (el) el.innerHTML = ""
    setHasContent(false)
    setPendingFile(null)
    // Keep typing: focus never leaves the composer across a send (t159).
    el?.focus()
  }

  const exec = (cmd: string) => {
    editorRef.current?.focus()
    document.execCommand(cmd)
    setHasContent(!!outgoingFromEditor(editorRef.current?.innerHTML ?? "").text)
  }

  const canSend = hasContent || !!pendingFile

  return (
    <div className="shrink-0 px-3 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div
        className={cn(
          "rounded-2xl border border-input bg-card shadow-sm transition-shadow",
          "focus-within:border-ring/40 focus-within:shadow-md focus-within:ring-2 focus-within:ring-ring/25",
        )}
      >
        {quotes && quotes.length > 0 && (
          <div className="flex flex-col gap-1 px-3 pt-3">
            {quotes.map((q) => (
              <div
                className="flex items-start gap-2 rounded-lg border-ring/30 border-l-2 bg-muted/40 py-1.5 pr-1.5 pl-2.5"
                key={q.id}
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-ring text-xs">{q.authorName}</div>
                  <div className="truncate text-muted-foreground text-xs">{q.preview}</div>
                </div>
                <button
                  aria-label="Remove quoted message"
                  className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent"
                  onClick={q.onCancel}
                  type="button"
                >
                  <HugeiconsIcon className="size-3" icon={Cancel01Icon} />
                </button>
              </div>
            ))}
          </div>
        )}
        {(pendingUrl || (pendingFile && !pendingUrl)) && (
          <div className="px-3 pt-3">
            <div className="relative inline-block">
              {pendingUrl ? (
                <img
                  alt="Attachment preview"
                  className="size-16 rounded-lg border border-border object-cover"
                  src={pendingUrl}
                />
              ) : (
                <div className="flex max-w-[16rem] items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
                  <HugeiconsIcon
                    className="size-4 shrink-0 text-muted-foreground"
                    icon={File01Icon}
                  />
                  <span className="truncate text-sm">{pendingFile?.name || "file"}</span>
                </div>
              )}
              <button
                aria-label="Remove attachment"
                className="-right-1.5 -top-1.5 absolute flex size-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm hover:bg-accent"
                onClick={() => setPendingFile(null)}
                type="button"
              >
                <HugeiconsIcon className="size-3" icon={Cancel01Icon} />
              </button>
            </div>
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
          onInput={() => setHasContent(!!readEditor().text)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              doSend()
            } else if (e.key === "Escape" && quotes && quotes.length > 0) {
              e.preventDefault()
              onEscape?.()
            }
          }}
          onPaste={(e) => {
            const file = pickFile(e.clipboardData?.items)
            if (file) {
              e.preventDefault()
              setPendingFile(file)
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
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) setPendingFile(f)
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
            <HugeiconsIcon className="size-4" icon={SentIcon} />
          </Button>
        </div>
      </div>
    </div>
  )
}
