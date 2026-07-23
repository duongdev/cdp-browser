import { Cancel01Icon, ComputerIcon, Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import type { ChatDensity, ChatSettings, ChatTheme } from "../lib/chat-settings"
import { NotifyToggle } from "./notify-toggle"

const THEME_OPTIONS: { id: ChatTheme; label: string; icon: IconSvgElement }[] = [
  { id: "system", label: "System", icon: ComputerIcon },
  { id: "light", label: "Light", icon: Sun03Icon },
  { id: "dark", label: "Dark", icon: Moon02Icon },
]

const DENSITY_OPTIONS: { id: ChatDensity; label: string }[] = [
  { id: "comfortable", label: "Comfortable" },
  { id: "compact", label: "Compact" },
]

function Segmented<T extends string>({
  value,
  options,
  onChange,
  cols,
}: {
  value: T
  options: { id: T; label: string; icon?: IconSvgElement }[]
  onChange: (v: T) => void
  cols: number
}) {
  return (
    <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {options.map(({ id, label, icon }) => (
        <button
          aria-pressed={value === id}
          className={cn(
            "flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] font-medium transition-colors coarse:min-h-11",
            value === id
              ? "bg-foreground text-background"
              : "bg-foreground/[0.06] text-muted-foreground hover:text-foreground",
          )}
          key={id}
          onClick={() => onChange(id)}
          type="button"
        >
          {icon && <HugeiconsIcon className="size-4" icon={icon} />}
          {label}
        </button>
      ))}
    </div>
  )
}

/** Chat settings drawer (t154): theme + density, plus the relocated push toggle. Persists per device
 *  in server ui-state via useChatSettings. Opened from the header gear + the ⌘K "Open settings". */
export function SettingsSheet({
  open,
  onOpenChange,
  settings,
  onUpdate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: ChatSettings
  onUpdate: (partial: Partial<ChatSettings>) => void
}) {
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="w-80 gap-0" showCloseButton={false}>
        <SheetHeader className="flex-row items-center justify-between">
          <div>
            <SheetTitle>Settings</SheetTitle>
            <SheetDescription>Saved per device.</SheetDescription>
          </div>
          <Button onClick={() => onOpenChange(false)} size="icon-sm" variant="ghost">
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
            <span className="sr-only">Close</span>
          </Button>
        </SheetHeader>

        <div className="flex flex-col gap-5 p-4 pt-2">
          <div className="space-y-2">
            <Label className="text-[13px]">Theme</Label>
            <Segmented
              cols={3}
              onChange={(theme) => onUpdate({ theme })}
              options={THEME_OPTIONS}
              value={settings.theme}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-[13px]">Density</Label>
            <Segmented
              cols={2}
              onChange={(density) => onUpdate({ density })}
              options={DENSITY_OPTIONS}
              value={settings.density}
            />
          </div>

          <div className="flex items-center justify-between border-border/60 border-t pt-3">
            <div>
              <Label className="text-[13px]">Notifications</Label>
              <p className="text-[11px] text-muted-foreground">Push to this device.</p>
            </div>
            <NotifyToggle />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
