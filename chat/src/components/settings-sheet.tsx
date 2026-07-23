import { Cancel01Icon, ComputerIcon, Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { isPointerFine, usePointerCoarse } from "@/hooks/use-pointer-coarse"
import { shouldArmLeaveTimer } from "@/lib/settings-dismiss"
import { cn } from "@/lib/utils"
import type {
  ChatDensity,
  ChatFont,
  ChatMono,
  ChatNameDisplay,
  ChatSettings,
  ChatTheme,
} from "../lib/chat-settings"
import { chatShell } from "../lib/chat-shell"
import { formatName } from "../lib/display-name"
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

const NAME_OPTIONS: { id: ChatNameDisplay; label: string }[] = [
  { id: "full", label: "Full name" },
  { id: "first", label: "First name" },
  { id: "regex", label: "Custom" },
]

// A live preview name so the regex mode is verifiable without leaving the sheet.
const NAME_PREVIEW = "Careen Tan - Group Office [C]"

// Each option previews itself in its own font (fontFamily) so the picker shows the actual typeface.
const FONT_OPTIONS: { id: ChatFont; label: string; fontFamily: string }[] = [
  { id: "svn-gilroy", label: "SVN-Gilroy", fontFamily: '"SVN-Gilroy", sans-serif' },
  { id: "anthropic-sans", label: "Anthropic Sans", fontFamily: '"Anthropic Sans", sans-serif' },
  { id: "anthropic-serif", label: "Anthropic Serif", fontFamily: '"Anthropic Serif", serif' },
  { id: "inter", label: "Inter", fontFamily: '"Inter Variable", sans-serif' },
  { id: "geist", label: "Geist", fontFamily: '"Geist Variable", sans-serif' },
  { id: "manrope", label: "Manrope", fontFamily: '"Manrope Variable", sans-serif' },
  { id: "roboto", label: "Roboto (Google)", fontFamily: '"Roboto Variable", sans-serif' },
  {
    id: "system",
    label: "System (Apple)",
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  },
]

const MONO_OPTIONS: { id: ChatMono; label: string; fontFamily: string }[] = [
  { id: "maple", label: "Maple Mono", fontFamily: '"Maple Mono", monospace' },
  { id: "anthropic-mono", label: "Anthropic Mono", fontFamily: '"Anthropic Mono", monospace' },
  { id: "dm-mono", label: "DM Mono", fontFamily: '"DM Mono", monospace' },
  { id: "geist-mono", label: "Geist Mono", fontFamily: '"Geist Mono Variable", monospace' },
  {
    id: "system-mono",
    label: "System Mono",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  },
]

function FontSelect<T extends string>({
  value,
  options,
  onChange,
  onOpenChange,
}: {
  value: T
  options: { id: T; label: string; fontFamily: string }[]
  onChange: (v: T) => void
  onOpenChange?: (open: boolean) => void
}) {
  return (
    <Select onOpenChange={onOpenChange} onValueChange={(v) => onChange(v as T)} value={value}>
      <SelectTrigger
        className="w-full"
        style={{ fontFamily: options.find((o) => o.id === value)?.fontFamily }}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(({ id, label, fontFamily }) => (
          <SelectItem key={id} style={{ fontFamily }} value={id}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

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

const LEAVE_CLOSE_MS = 500

/** Chat settings drawer (t154): theme + density, plus the relocated push toggle. Persists per device
 *  in server ui-state via useChatSettings. Opened from the header gear + the ⌘K "Open settings".
 *
 *  Non-modal, no-overlay, mouse-leave auto-close — same UX as the CDP Browser settings drawer (t049,
 *  applied to web + electron here per PSN-91): flick the cursor off the panel and it dismisses (fine
 *  pointer only, via `shouldArmLeaveTimer`); a coarse pointer dismisses via the X or a scrim tap. Any
 *  keydown inside "commits" the drawer so it stops auto-closing while you're editing a field. */
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
  const pointerCoarse = usePointerCoarse()
  // Electron shell: the server the app loads /chat from, editable here (web build hides this).
  const shell = chatShell()
  const [serverUrl, setServerUrlInput] = useState("")
  const [serverSaved, setServerSaved] = useState("")
  useEffect(() => {
    if (open && shell)
      shell.getServerUrl().then((u) => {
        setServerUrlInput(u)
        setServerSaved(u)
      })
  }, [open, shell])
  // A portaled Select (Font pickers) opens off-panel — suppress the leave-timer while it's open.
  const [selectOpen, setSelectOpen] = useState(false)
  // Once the user interacts via keyboard, stop auto-closing on mouse-leave (they're committed).
  const [committed, setCommitted] = useState(false)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const clearLeaveTimer = () => clearTimeout(leaveTimer.current)

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      clearLeaveTimer()
      setCommitted(false)
    }
    onOpenChange(next)
  }

  return (
    <Sheet modal={false} onOpenChange={handleOpenChange} open={open}>
      {/* Coarse-pointer dismiss: no hover on a finger, so a scrim tap replaces mouse-leave. */}
      {open && pointerCoarse && (
        <button
          aria-label="Close settings"
          className="fixed inset-0 z-40 cursor-default bg-transparent"
          onClick={() => handleOpenChange(false)}
          tabIndex={-1}
          type="button"
        />
      )}
      <SheetContent
        className="w-80 gap-0"
        onInteractOutside={(e) => {
          // Keep open when interacting with a Select popover it spawned (portals outside the panel).
          const target = e.target as HTMLElement | null
          if (target?.closest('[data-slot="select-content"],[data-radix-popper-content-wrapper]'))
            e.preventDefault()
        }}
        onKeyDownCapture={() => {
          clearLeaveTimer()
          setCommitted(true)
        }}
        onMouseEnter={clearLeaveTimer}
        onMouseLeave={() => {
          // Read the pointer live so a Magic-Keyboard detach flips to the coarse branch with no reload.
          if (!shouldArmLeaveTimer({ pointerFine: isPointerFine(), committed, selectOpen })) return
          clearLeaveTimer()
          leaveTimer.current = setTimeout(() => handleOpenChange(false), LEAVE_CLOSE_MS)
        }}
        showCloseButton={false}
        showOverlay={false}
      >
        <SheetHeader className="flex-row items-center justify-between">
          <div>
            <SheetTitle>Settings</SheetTitle>
            <SheetDescription>Saved per device.</SheetDescription>
          </div>
          <Button onClick={() => handleOpenChange(false)} size="icon-sm" variant="ghost">
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
            <Label className="text-[13px]">Names</Label>
            <Segmented
              cols={3}
              onChange={(nameDisplay) => onUpdate({ nameDisplay })}
              options={NAME_OPTIONS}
              value={settings.nameDisplay}
            />
            {settings.nameDisplay === "regex" && (
              <input
                className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-[13px] outline-none focus:ring-1 focus:ring-ring"
                onChange={(e) => onUpdate({ nameRegex: e.target.value })}
                placeholder="Strip pattern, e.g.  - .*$"
                spellCheck={false}
                value={settings.nameRegex}
              />
            )}
            {settings.nameDisplay !== "full" && (
              <p className="text-[11px] text-muted-foreground">
                {NAME_PREVIEW} →{" "}
                {formatName(NAME_PREVIEW, {
                  mode: settings.nameDisplay,
                  regex: settings.nameRegex,
                })}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label className="text-[13px]">Font</Label>
            <FontSelect
              onChange={(font) => onUpdate({ font })}
              onOpenChange={setSelectOpen}
              options={FONT_OPTIONS}
              value={settings.font}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-[13px]">Code font</Label>
            <FontSelect
              onChange={(mono) => onUpdate({ mono })}
              onOpenChange={setSelectOpen}
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

          {/* Server URL — Electron shell only (the web build is served by its own origin). */}
          {shell && (
            <div className="space-y-2 border-border/60 border-t pt-3">
              <Label className="text-[13px]">Server</Label>
              <div className="flex gap-1.5">
                <input
                  className="min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 py-1.5 text-[13px] outline-none focus:ring-1 focus:ring-ring"
                  onChange={(e) => setServerUrlInput(e.target.value)}
                  placeholder="https://…"
                  spellCheck={false}
                  value={serverUrl}
                />
                <Button
                  disabled={!serverUrl.trim() || serverUrl.trim() === serverSaved}
                  onClick={() => shell.setServerUrl(serverUrl.trim())}
                  size="sm"
                  variant="secondary"
                >
                  Save
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">Reloads the app to this server.</p>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
