import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useCallback, useEffect, useImperativeHandle, useReducer, useRef } from "react"
import { Button } from "@/components/ui/button"
import { closedFindState, counterLabel, reduce } from "@/lib/find-bar"
import type { RemotePage } from "@/lib/remote-page"
import { cn } from "@/lib/utils"

export interface FindBarHandle {
  /** Open + focus (or re-focus/select if already open) — the Cmd+F / toolbar action. */
  open: () => void
}

interface FindBarProps {
  page: RemotePage
  ref?: React.Ref<FindBarHandle>
}

/**
 * In-page find overlay (t001). Owns the pure find-state reducer, drives the Remote Page
 * find intentions (search / step / clear) over CDP, and feeds the reported match total
 * back into the reducer. Renders above the screencast canvas via z-index (same in-DOM
 * overlay discipline as dialogs / local-webviews; see ADR-0005). Touch targets ≥44pt
 * come for free from the shadcn `Button` coarse-pointer bump (t048).
 */
export function FindBar({ page, ref }: FindBarProps) {
  const [state, dispatch] = useReducer(reduce, closedFindState)
  const inputRef = useRef<HTMLInputElement>(null)

  useImperativeHandle(ref, () => ({
    open: () => {
      dispatch({ type: "open" })
      // Defer so the input is mounted (when opening from closed) before focusing.
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    },
  }))

  const runSearch = useCallback(
    (query: string) => {
      dispatch({ type: "setQuery", query })
      if (!query) {
        page.clearFind()
        return
      }
      // `setQuery` already reset total to 0; a rejected find (socket drop) just stays there
      // instead of becoming an unhandled rejection (t096, P11).
      page
        .find(query)
        .then(({ total }) => dispatch({ type: "setTotal", total }))
        .catch(() => {})
    },
    [page],
  )

  const step = useCallback(
    (dir: "next" | "prev") => {
      if (state.total === 0) return
      dispatch({ type: dir })
      page.findStep(dir)
    },
    [page, state.total],
  )

  const close = useCallback(() => {
    dispatch({ type: "close" })
    page.clearFind()
  }, [page])

  // Clear any highlight left on the remote page if the bar unmounts while open.
  useEffect(() => {
    if (!state.open) return
    return () => {
      page.clearFind()
    }
  }, [state.open, page])

  if (!state.open) return null

  const label = counterLabel(state)
  const hasMatches = state.total > 0

  return (
    <div className="absolute top-3 right-3 z-30 flex items-center gap-1 rounded-xl border border-border bg-card/95 p-1 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-card/80">
      <HugeiconsIcon className="ml-1.5 size-3.5 text-muted-foreground" icon={Search01Icon} />
      <input
        aria-label="Find in page"
        className="touch-slop-y h-9 w-44 bg-transparent px-1 text-sm text-foreground placeholder:text-muted-foreground outline-none"
        onChange={(e) => runSearch(e.target.value)}
        onKeyDown={(e) => {
          // Keep the find input out of the Input Forwarding path — never let a keystroke
          // reach the global keydown handler / remote page while the bar is focused.
          e.stopPropagation()
          if (e.key === "Enter") {
            e.preventDefault()
            step(e.shiftKey ? "prev" : "next")
          } else if (e.key === "Escape") {
            e.preventDefault()
            close()
          }
        }}
        placeholder="Find in page"
        ref={inputRef}
        type="text"
        value={state.query}
      />
      <span
        className={cn(
          "min-w-12 px-1 text-center text-xs tabular-nums",
          hasMatches ? "text-muted-foreground" : "text-destructive",
        )}
      >
        {label}
      </span>
      <Button
        aria-label="Previous match"
        className="text-muted-foreground hover:text-foreground disabled:opacity-30"
        disabled={!hasMatches}
        onClick={() => step("prev")}
        size="icon-sm"
        variant="ghost"
      >
        <HugeiconsIcon className="size-4" icon={ArrowUp01Icon} />
      </Button>
      <Button
        aria-label="Next match"
        className="text-muted-foreground hover:text-foreground disabled:opacity-30"
        disabled={!hasMatches}
        onClick={() => step("next")}
        size="icon-sm"
        variant="ghost"
      >
        <HugeiconsIcon className="size-4" icon={ArrowDown01Icon} />
      </Button>
      <Button
        aria-label="Close find bar"
        className="text-muted-foreground hover:text-foreground"
        onClick={close}
        size="icon-sm"
        variant="ghost"
      >
        <HugeiconsIcon className="size-4" icon={Cancel01Icon} />
      </Button>
    </div>
  )
}
