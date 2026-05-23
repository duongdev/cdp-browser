import { Settings01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export type SwitchEffect = "none" | "blur" | "grayscale" | "blur-grayscale"

interface SettingsDialogProps {
  open: boolean
  /** True when opened via Cmd+, — starts in committed mode (no leave-timer). */
  committed: boolean
  onOpenChange: (open: boolean) => void
  /** Gear clicked while closed: open in mouse mode (leave-timer armed). */
  onRequestOpenMouse: () => void
  /** First keypress inside the drawer promotes it to committed mode. */
  onCommit: () => void
  theme: "system" | "light" | "dark"
  onThemeChange: (theme: "system" | "light" | "dark") => void
  onConfigSaved?: () => void
  adaptiveViewport: boolean
  onAdaptiveViewportChange: (enabled: boolean) => void
  forceOnClient: boolean
  onForceOnClientChange: (enabled: boolean) => void
  /** The device-metrics size currently imposed, or null when not active. */
  emulatedSize: { w: number; h: number } | null
  switchEffect: SwitchEffect
  onSwitchEffectChange: (effect: SwitchEffect) => void
  notificationsEnabled: boolean
  onNotificationsEnabledChange: (enabled: boolean) => void
}

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok"; browser: string }
  | { status: "error"; message: string }

/** How long the cursor can sit outside a mouse-opened drawer before it closes. */
const LEAVE_CLOSE_MS = 500

/**
 * Turn raw connection failures (Node's "fetch failed", ECONNREFUSED, …) into a
 * message that tells the operator what to actually check. Falls back to the raw
 * text for errors we don't recognise.
 */
function humanizeConnError(message: string, host: string, port: string): string {
  const m = message.toLowerCase()
  if (
    /fetch failed|econnrefused|enotfound|ehostunreach|etimedout|network|timeout|abort|failed to fetch/.test(
      m,
    )
  ) {
    return `Couldn't reach ${host}:${port}. Check the address and that the remote browser is running with --remote-debugging-port=${port}.`
  }
  return message
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border/60 bg-card/40 p-3.5">
      <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/80">
        {title}
      </h3>
      {children}
    </section>
  )
}

export function SettingsDialog({
  open,
  committed,
  onOpenChange,
  onRequestOpenMouse,
  onCommit,
  theme,
  onThemeChange,
  onConfigSaved,
  adaptiveViewport,
  onAdaptiveViewportChange,
  forceOnClient,
  onForceOnClientChange,
  emulatedSize,
  switchEffect,
  onSwitchEffectChange,
  notificationsEnabled,
  onNotificationsEnabledChange,
}: SettingsDialogProps) {
  const [host, setHost] = useState("")
  const [port, setPort] = useState("")
  const [saved, setSaved] = useState({ host: "", port: "" })
  const [saving, setSaving] = useState(false)
  const [test, setTest] = useState<TestState>({ status: "idle" })

  // Suppress the leave-timer while a Select popover (portaled outside the panel)
  // is open — the cursor naturally travels off-panel to reach its options.
  const [selectOpen, setSelectOpen] = useState(false)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (open) {
      setTest({ status: "idle" })
      window.cdp.getConfig().then((config) => {
        const p = String(config.port)
        setHost(config.host)
        setPort(p)
        setSaved({ host: config.host, port: p })
      })
    }
  }, [open])

  const clearLeaveTimer = useCallback(() => {
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current)
      leaveTimer.current = undefined
    }
  }, [])

  // A committed drawer (keyboard / Cmd+,) never auto-closes on leave.
  useEffect(() => {
    if (committed) clearLeaveTimer()
  }, [committed, clearLeaveTimer])

  useEffect(() => clearLeaveTimer, [clearLeaveTimer])

  const dirty = host !== saved.host || port !== saved.port

  const parsedConfig = () => ({ host, port: parseInt(port, 10) || 9222 })

  const handleTest = async () => {
    setTest({ status: "testing" })
    const result = await window.cdp.testConfig(parsedConfig())
    if ("ok" in result) {
      setTest({ status: "ok", browser: result.browser })
    } else {
      setTest({ status: "error", message: result.error })
    }
  }

  const handleSave = async () => {
    setSaving(true)
    await window.cdp.setConfig(parsedConfig())
    setSaved({ host, port })
    setSaving(false)
    onConfigSaved?.()
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            className="text-muted-foreground hover:text-foreground"
            onClick={() => (open ? onOpenChange(false) : onRequestOpenMouse())}
            size="icon-xs"
            variant="ghost"
          >
            <HugeiconsIcon className="size-3.5" icon={Settings01Icon} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Settings</TooltipContent>
      </Tooltip>

      <Sheet modal={false} onOpenChange={onOpenChange} open={open}>
        <SheetContent
          aria-describedby={undefined}
          className="flex w-[380px] flex-col gap-0 p-0 sm:max-w-[380px]"
          // Keep the non-modal drawer open when interacting with a Select
          // popover it spawned (those portal outside the panel's DOM bounds).
          onInteractOutside={(e) => {
            const target = e.target as HTMLElement | null
            if (
              target?.closest('[data-slot="select-content"],[data-radix-popper-content-wrapper]')
            ) {
              e.preventDefault()
            }
          }}
          onKeyDownCapture={() => {
            clearLeaveTimer()
            onCommit()
          }}
          onMouseEnter={clearLeaveTimer}
          onMouseLeave={() => {
            if (committed || selectOpen) return
            clearLeaveTimer()
            leaveTimer.current = setTimeout(() => onOpenChange(false), LEAVE_CLOSE_MS)
          }}
          showOverlay={false}
          side="right"
        >
          <SheetHeader className="px-5 pt-5 pb-1">
            <SheetTitle className="text-sm">Settings</SheetTitle>
          </SheetHeader>

          <div className="flex flex-col gap-3 overflow-y-auto px-5 pt-2 pb-6">
            {/* Appearance */}
            <Card title="Appearance">
              <div className="space-y-2">
                <Label className="text-[13px]">Theme</Label>
                <Select
                  onOpenChange={setSelectOpen}
                  onValueChange={(v) => onThemeChange(v as "system" | "light" | "dark")}
                  value={theme}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="system">System</SelectItem>
                    <SelectItem value="light">Light</SelectItem>
                    <SelectItem value="dark">Dark</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </Card>

            {/* Viewport */}
            <Card title="Viewport">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-0.5">
                  <Label className="text-[13px]">Adaptive viewport</Label>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    Resize the remote page to fill the window — no letterbox bars.
                  </p>
                </div>
                <Switch
                  checked={adaptiveViewport}
                  className="mt-0.5"
                  onCheckedChange={onAdaptiveViewportChange}
                />
              </div>

              <div
                className={
                  "mt-3 border-l border-border/60 pl-3 transition-opacity " +
                  (adaptiveViewport ? "" : "pointer-events-none opacity-40")
                }
              >
                <label
                  className="flex cursor-pointer items-start gap-2.5"
                  htmlFor="force-on-client"
                >
                  <Checkbox
                    checked={forceOnClient}
                    className="mt-0.5"
                    disabled={!adaptiveViewport}
                    id="force-on-client"
                    onCheckedChange={(v) => onForceOnClientChange(v === true)}
                  />
                  <span className="space-y-0.5">
                    <span className="block text-[12.5px] leading-snug text-foreground">
                      Auto-recover after the host takes over
                    </span>
                    <span className="block text-[11px] leading-snug text-muted-foreground">
                      Re-applies the client size when you return, instead of switching off.
                    </span>
                  </span>
                </label>
                <p className="mt-2.5 text-[11px] tabular-nums text-muted-foreground/70">
                  {emulatedSize
                    ? `Emulating ${emulatedSize.w} × ${emulatedSize.h}`
                    : "Active once connected."}
                </p>
              </div>

              <div className="mt-3.5 space-y-2 border-t border-border/40 pt-3.5">
                <Label className="text-[13px]">Transition on tab switch</Label>
                <Select
                  onOpenChange={setSelectOpen}
                  onValueChange={(v) => onSwitchEffectChange(v as SwitchEffect)}
                  value={switchEffect}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="blur">Blur</SelectItem>
                    <SelectItem value="grayscale">Grayscale</SelectItem>
                    <SelectItem value="blur-grayscale">Blur + Grayscale</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </Card>

            {/* Notifications */}
            <Card title="Notifications">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-0.5">
                  <Label className="text-[13px]">Desktop notifications</Label>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    Show a system notification for Teams messages when its tab isn't in view.
                  </p>
                </div>
                <Switch
                  checked={notificationsEnabled}
                  className="mt-0.5"
                  onCheckedChange={onNotificationsEnabledChange}
                />
              </div>
            </Card>

            <Card title="Connection">
              <div className="space-y-2">
                <Label className="text-[13px]">Remote CDP address</Label>
                <div className="flex gap-2">
                  <Input
                    className="flex-1"
                    onChange={(e) => {
                      setHost(e.target.value)
                      setTest({ status: "idle" })
                    }}
                    placeholder="Host"
                    value={host}
                  />
                  <Input
                    className="w-20"
                    onChange={(e) => {
                      setPort(e.target.value)
                      setTest({ status: "idle" })
                    }}
                    placeholder="Port"
                    type="number"
                    value={port}
                  />
                </div>
                <div className="flex gap-2 pt-0.5">
                  <Button
                    className="flex-1"
                    disabled={test.status === "testing"}
                    onClick={handleTest}
                    size="sm"
                    variant="outline"
                  >
                    {test.status === "testing" ? "Testing…" : "Test"}
                  </Button>
                  <Button
                    className="flex-1"
                    disabled={saving || !dirty}
                    onClick={handleSave}
                    size="sm"
                  >
                    {saving ? "Saving…" : "Save"}
                  </Button>
                </div>
                {test.status === "ok" ? (
                  <p className="text-[11px] text-emerald-500">Connected — {test.browser}</p>
                ) : test.status === "error" ? (
                  <p className="text-[11px] text-red-500">
                    {humanizeConnError(test.message, host, port)}
                  </p>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    Saving reconnects the active tab.
                  </p>
                )}
              </div>
            </Card>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
