import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

interface PromptOpts {
  title: string
  description?: string
  initialValue?: string
  placeholder?: string
}

interface PromptState extends PromptOpts {
  resolve: (value: string | null) => void
}

// Module-level controller — one setter registered by the single mounted PromptDialog.
let _open: ((state: PromptState) => void) | null = null

/** Show a prompt dialog. Returns the entered string (including blank) or null if cancelled. */
export function prompt(opts: PromptOpts): Promise<string | null> {
  return new Promise((resolve) => {
    if (!_open) {
      // Fallback when PromptDialog is not mounted (should not happen in normal use).
      resolve(window.prompt(opts.title, opts.initialValue ?? ""))
      return
    }
    _open({ ...opts, resolve })
  })
}

/** Mount once in chat-app.tsx alongside ProfileDialog. */
export function PromptDialog() {
  const [state, setState] = useState<PromptState | null>(null)
  const [value, setValue] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    _open = (s) => {
      setValue(s.initialValue ?? "")
      setState(s)
    }
    return () => {
      _open = null
    }
  }, [])

  // Focus + select-all on open. The triggering context menu / palette restores focus to its own
  // trigger on close — that restore lands AFTER the dialog opens and steals the caret. Re-assert
  // focus every frame for the whole settle window (not just until it first lands, or the late
  // restore wins), selecting once so the caret stays put after it sticks.
  useEffect(() => {
    if (!state) return
    const start = performance.now()
    let raf = 0
    let selected = false
    const tick = () => {
      const el = inputRef.current
      if (el && document.activeElement !== el) {
        el.focus()
        if (!selected) {
          el.select()
          selected = true
        }
      }
      if (performance.now() - start < 350) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [state])

  const confirm = () => {
    state?.resolve(value)
    setState(null)
  }

  const cancel = () => {
    state?.resolve(null)
    setState(null)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      confirm()
    }
  }

  return (
    <Dialog onOpenChange={(open) => !open && cancel()} open={!!state}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{state?.title}</DialogTitle>
          {state?.description && <DialogDescription>{state.description}</DialogDescription>}
        </DialogHeader>
        <Input
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={state?.placeholder}
          ref={inputRef}
          value={value}
        />
        <DialogFooter>
          <Button onClick={cancel} variant="outline">
            Cancel
          </Button>
          <Button onClick={confirm}>Confirm</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
