import { useMemo, useState } from "react"
import { toast } from "sonner"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import { type Action, type ActionGroup, filterActions, OVERLAY_GROUPS } from "@/lib/hotkey-registry"

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Built by app.tsx from its existing handlers (the registry's run-fns). */
  actions: Action[]
}

/**
 * The ⌘K command palette. Presentation over the hotkey registry: cmdk's internal filter is
 * disabled (`shouldFilter={false}`) so the registry's `filterActions` stays the single
 * source of truth. Running an item invokes the action's `run` (the same handler the
 * existing hotkey/toolbar path already calls) and closes the palette. Focus restoration is
 * handled by the underlying radix Dialog (returns focus to the opener on close).
 */
export function CommandPalette({ open, onOpenChange, actions }: CommandPaletteProps) {
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => filterActions(actions, query), [actions, query])

  // Partition the filtered list into the ux.md groups, preserving registration order.
  // Unlike the overlay, the palette shows every action — including ones with no hotkey
  // (e.g. "Switch to <tab>") — so we group here rather than reuse `groupForOverlay`.
  const grouped = useMemo(() => {
    const out = new Map<ActionGroup, Action[]>(OVERLAY_GROUPS.map((g) => [g, []]))
    for (const a of filtered) out.get(a.group)?.push(a)
    return out
  }, [filtered])

  const run = (action: Action) => {
    onOpenChange(false)
    setQuery("")
    // State is already cleaned up above, so a throwing run-fn can't leave the palette in an
    // odd state — surface it as a toast instead of an unhandled error (t096, P19).
    try {
      action.run()
    } catch {
      toast.error(`Couldn't run "${action.name}"`)
    }
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) setQuery("")
    onOpenChange(next)
  }

  return (
    <CommandDialog onOpenChange={handleOpenChange} open={open} shouldFilter={false}>
      <CommandInput
        onValueChange={setQuery}
        placeholder="Search actions, tabs, settings…"
        value={query}
      />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        {OVERLAY_GROUPS.map((group) => {
          const rows = grouped.get(group) ?? []
          if (rows.length === 0) return null
          return (
            <CommandGroup heading={group} key={group}>
              {rows.map((action) => (
                <CommandItem
                  key={action.id}
                  // cmdk filtering is off; a stable value keeps keyboard selection sane.
                  onSelect={() => run(action)}
                  value={action.id}
                >
                  <span className="truncate">{action.name}</span>
                  {action.hotkey && <CommandShortcut>{action.hotkey}</CommandShortcut>}
                </CommandItem>
              ))}
            </CommandGroup>
          )
        })}
      </CommandList>
    </CommandDialog>
  )
}
