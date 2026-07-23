import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { type ChatAction, groupForOverlay, OVERLAY_GROUPS } from "../lib/command-registry"

interface ShortcutOverlayProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The same registry the palette consumes — the overlay is auto-generated, never a second edit. */
  actions: ChatAction[]
}

/** The `?` shortcut-help overlay (t152). Auto-generated from the command registry via
 *  `groupForOverlay`, so adding an action with a `keys` hint makes it appear here and in the palette
 *  with no second edit. Only actions with a hint appear. */
export function ShortcutOverlay({ open, onOpenChange, actions }: ShortcutOverlayProps) {
  const grouped = groupForOverlay(actions)

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Press ⌘K for the command palette.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {OVERLAY_GROUPS.map((group) => {
            const rows = grouped[group]
            if (rows.length === 0) return null
            return (
              <section className="grid gap-1.5" key={group}>
                <h3 className="font-medium text-muted-foreground text-xs">{group}</h3>
                <ul className="grid gap-1">
                  {rows.map((action) => (
                    <li className="flex items-center justify-between gap-4 text-sm" key={action.id}>
                      <span className="truncate text-foreground">{action.label}</span>
                      <Kbd>{action.keys}</Kbd>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Kbd({ children }: { children: ChatAction["keys"] }) {
  return (
    <kbd className="shrink-0 rounded border border-border/70 bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {children}
    </kbd>
  )
}
