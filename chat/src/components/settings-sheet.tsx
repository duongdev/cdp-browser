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
import type { ChatDensity, ChatFont, ChatMono, ChatSettings, ChatTheme } from "../lib/chat-settings"
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

// The label previews itself in its own font (fontFamily) so the picker shows the actual typeface.
const FONT_OPTIONS: { id: ChatFont; label: string; fontFamily: string }[] = [
  { id: "svn-gilroy", label: "SVN-Gilroy", fontFamily: '"SVN-Gilroy", sans-serif' },
  { id: "anthropic-sans", label: "Anthropic Sans", fontFamily: '"Anthropic Sans", sans-serif' },
  { id: "anthropic-serif", label: "Anthropic Serif", fontFamily: '"Anthropic Serif", serif' },
  { id: "manrope", label: "Manrope", fontFamily: '"Manrope Variable", sans-serif' },
]

const MONO_OPTIONS: { id: ChatMono; label: string; fontFamily: string }[] = [
  { id: "maple", label: "Maple Mono", fontFamily: '"Maple Mono", monospace' },
  { id: "anthropic-mono", label: "Anthropic Mono", fontFamily: '"Anthropic Mono", monospace' },
  { id: "dm-mono", label: "DM Mono", fontFamily: '"DM Mono", monospace' },
]

function Segmented<T extends string>({
  value,
  options,
  onChange,
  cols,
}: {
  value: T
  options: { id: T; label: string; icon?: IconSvgElement; fontFamily?: string }[]
  onChange: (v: T) => void
  cols: number
}) {
  return (
    <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {options.map(({ id, label, icon, fontFamily }) => (
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
          style={fontFamily ? { fontFamily } : undefined}
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

          <div className="space-y-2">
            <Label className="text-[13px]">Font</Label>
            <Segmented
              cols={2}
              onChange={(font) => onUpdate({ font })}
              options={FONT_OPTIONS}
              value={settings.font}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-[13px]">Code font</Label>
            <Segmented
              cols={1}
              onChange={(mono) => onUpdate({ mono })}
              options={MONO_OPTIONS}
              value={settings.mono}
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
