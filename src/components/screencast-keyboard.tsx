import { KeyboardIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useCallback, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import type { RemotePage } from "@/lib/remote-page"
import { keyDownAction, synthKey } from "@/lib/screencast-keys"
import { diffInput } from "@/lib/text-input-delta"
import { cn } from "@/lib/utils"

interface Props {
  page: RemotePage
}

// Reset the shadow field past this length (at a caret-at-end boundary) so it never grows
// unbounded; the iOS candidate bar survives because we only reset between words.
const RESET_LEN = 80

/**
 * On-screen keyboard bridge for the screencast (t084 + t086 fixes). The canvas has no
 * focusable field, so iOS never raises a keyboard. A hidden `<textarea>` + a floating
 * button: tapping focuses the field (keyboard appears) and edits forward to the Remote Page.
 *
 * Two channels, no overlap:
 *  - Text + in-field deletes ride the `input` delta (`diffInput`): inserted text →
 *    `Input.insertText`, removed tail → Backspace key events (with VK 8). This is the
 *    reliable path on iOS — it captures printable keys, autocorrect, predictive text,
 *    composed input (Vietnamese/CJK), and paste, none of which fire usable keydowns.
 *  - Non-text keys (Enter/Tab/arrows/Esc/Delete) forward from `keydown` with real VK codes.
 *    An empty-field Backspace also forwards here (the field can't shrink to signal it).
 */
export function ScreencastKeyboard({ page }: Props) {
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const lastValueRef = useRef("")
  const [active, setActive] = useState(false)

  const forwardKey = useCallback(
    (key: string) => {
      const k = synthKey(key)
      page.forwardInput({ kind: "key", phase: "down", event: k as unknown as KeyboardEvent })
      page.forwardInput({ kind: "key", phase: "up", event: k as unknown as KeyboardEvent })
    },
    [page],
  )

  // The field changed: forward the minimal delta (delete the changed tail, type the new
  // tail). Covers typing, autocorrect-replace, word delete, composition, and paste.
  const onInput = useCallback(() => {
    const el = fieldRef.current
    if (!el) return
    const { backspaces, insert } = diffInput(lastValueRef.current, el.value)
    for (let i = 0; i < backspaces; i++) forwardKey("Backspace")
    if (insert) page.paste(insert, { rich: false })
    lastValueRef.current = el.value
    if (el.value.length >= RESET_LEN && el.selectionStart === el.value.length) {
      el.value = ""
      lastValueRef.current = ""
    }
  }, [page, forwardKey])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const action = keyDownAction(e.key, e.currentTarget.value === "")
      if (action.type === "forward") {
        e.preventDefault()
        forwardKey(action.key)
      }
    },
    [forwardKey],
  )

  // Belt-and-suspenders for a soft-keyboard Return that fires no keydown: catch the line
  // break before it reaches the field and forward Enter instead of inserting "\n".
  const onBeforeInput = useCallback(
    (e: React.FormEvent<HTMLTextAreaElement>) => {
      const inputType = (e.nativeEvent as InputEvent).inputType
      if (inputType === "insertLineBreak" || inputType === "insertParagraph") {
        e.preventDefault()
        forwardKey("Enter")
      }
    },
    [forwardKey],
  )

  const toggle = useCallback(() => {
    const el = fieldRef.current
    if (!el) return
    if (active) {
      el.blur()
    } else {
      el.value = ""
      lastValueRef.current = ""
      el.focus()
    }
  }, [active])

  return (
    <>
      <textarea
        aria-hidden="true"
        autoCapitalize="sentences"
        autoCorrect="on"
        className="pointer-events-none absolute bottom-0 right-0 size-px opacity-0"
        onBeforeInput={onBeforeInput}
        onBlur={() => setActive(false)}
        onChange={onInput}
        onFocus={() => setActive(true)}
        onKeyDown={onKeyDown}
        ref={fieldRef}
        spellCheck={false}
        tabIndex={-1}
      />
      <Button
        aria-label={active ? "Hide keyboard" : "Show keyboard"}
        aria-pressed={active}
        className={cn(
          "absolute bottom-4 right-4 z-20 size-11 rounded-full shadow-lg",
          active && "ring-2 ring-primary",
        )}
        onClick={toggle}
        size="icon"
        variant={active ? "default" : "secondary"}
      >
        <HugeiconsIcon className="size-5" icon={KeyboardIcon} />
      </Button>
    </>
  )
}
