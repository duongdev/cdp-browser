import { useMemo, useState } from "react"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import {
  type ActionGroup,
  actionsForContext,
  type ChatAction,
  type ChatContext,
  filterActions,
  OVERLAY_GROUPS,
} from "../lib/command-registry"

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The full registry (built by chat-app from its handlers). Filtered by context here. */
  actions: ChatAction[]
  ctx: ChatContext
}

/** The chat ⌘K palette (t152). Presentation over the pure command registry: cmdk's own filter is
 *  off (`shouldFilter={false}`) so `filterActions` (diacritic-safe fuzzy) is the single source. Only
 *  actions valid in the current context appear. Running an item invokes its injected `run`. */
export function CommandPalette({ open, onOpenChange, actions, ctx }: CommandPaletteProps) {
  const [query, setQuery] = useState("")

  const available = useMemo(() => actionsForContext(actions, ctx), [actions, ctx])
  const filtered = useMemo(() => filterActions(available, query), [available, query])

  const grouped = useMemo(() => {
    const out = new Map<ActionGroup, ChatAction[]>(OVERLAY_GROUPS.map((g) => [g, []]))
    for (const a of filtered) out.get(a.group)?.push(a)
    return out
  }, [filtered])

  const run = (action: ChatAction) => {
    onOpenChange(false)
    setQuery("")
    action.run()
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) setQuery("")
    onOpenChange(next)
  }

  return (
    <CommandDialog onOpenChange={handleOpenChange} open={open} shouldFilter={false}>
      <CommandInput
        onValueChange={setQuery}
        placeholder="Jump to a conversation, run an action…"
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
                <CommandItem key={action.id} onSelect={() => run(action)} value={action.id}>
                  <span className="truncate">{action.label}</span>
                  {action.keys && <CommandShortcut>{action.keys}</CommandShortcut>}
                </CommandItem>
              ))}
            </CommandGroup>
          )
        })}
      </CommandList>
    </CommandDialog>
  )
}
