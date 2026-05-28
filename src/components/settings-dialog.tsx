import { Settings01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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
import { getCaps } from "@/lib/cdp-web-transport"
import type { InputTransportMode } from "@/lib/transport-selector"
import { cn } from "@/lib/utils"

// VAPID public key is delivered as URL-safe base64 by the server; pushManager.subscribe
// expects a raw ArrayBuffer. Standard helper from the Web Push spec.
function urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/")
  const rawData = atob(base64)
  const buf = new ArrayBuffer(rawData.length)
  const view = new Uint8Array(buf)
  for (let i = 0; i < rawData.length; i++) view[i] = rawData.charCodeAt(i)
  return buf
}

export type SwitchEffect = "none" | "blur" | "grayscale" | "blur-grayscale"

// Map the internal transport mode key to the same friendly label the picker uses,
// so the active-mode badge reads consistently with the toggle ("Active: Fastest").
function transportLabel(m: InputTransportMode): string {
  if (m === "auto") return "Auto"
  if (m === "ws") return "Fastest"
  if (m === "stream") return "Streaming"
  return "Basic"
}

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
  syncTheme: boolean
  onSyncThemeChange: (enabled: boolean) => void
  autoGrantLocalMedia: boolean
  onAutoGrantLocalMediaChange: (enabled: boolean) => void
  localExtensions: LocalExtensionInfo[]
  onAddLocalExtension: () => void
  onReloadLocalExtension: (path: string) => void
  onRemoveLocalExtension: (path: string) => void
  onOpenExtensionUrl: (url: string) => void
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
  syncTheme,
  onSyncThemeChange,
  autoGrantLocalMedia,
  onAutoGrantLocalMediaChange,
  localExtensions,
  onAddLocalExtension,
  onReloadLocalExtension,
  onRemoveLocalExtension,
  onOpenExtensionUrl,
}: SettingsDialogProps) {
  const [tab, setTab] = useState<"remote" | "local">("remote")
  const caps = getCaps()
  const [pendingRemoveExt, setPendingRemoveExt] = useState<LocalExtensionInfo | null>(null)
  const [host, setHost] = useState("")
  const [port, setPort] = useState("")
  const [saved, setSaved] = useState({ host: "", port: "" })
  const [saving, setSaving] = useState(false)
  const [test, setTest] = useState<TestState>({ status: "idle" })
  // Web-only "Push notifications" toggle — self-contained (reads/writes ui-state directly,
  // like the Connection card), since it's a leaf web concern not worth prop-drilling.
  const [webPush, setWebPush] = useState(false)
  const [pushPermBlocked, setPushPermBlocked] = useState(false)
  const [isStandalone, setIsStandalone] = useState(false)
  // Web-only connection mode picker (t019). The pref persists to localStorage; calling
  // window.cdp.reconfigureInputTransport() re-opens/closes the WS to apply mid-session
  // (no reload needed). The "active" badge mirrors what actually connected — under Auto
  // this may differ from the picked mode if WS was unreachable and we fell to Stream.
  const [inputTransport, setInputTransport] = useState<InputTransportMode>(() =>
    typeof localStorage !== "undefined"
      ? ((localStorage.getItem("inputTransport") as InputTransportMode | null) ?? "auto")
      : "auto",
  )
  const [activeTransport, setActiveTransport] = useState<InputTransportMode>(
    () => window.cdp?.getActiveTransport?.() ?? "batch",
  )
  useEffect(() => {
    const onChange = (m: InputTransportMode) => setActiveTransport(m)
    window.cdp?.onActiveTransportChange?.(onChange)
    // No unsubscribe surface on the bridge; the listener is harmless on remount and the
    // settings dialog is a long-lived singleton in practice.
  }, [])

  const toggleWebPush = useCallback(async (on: boolean) => {
    if (on && typeof Notification !== "undefined") {
      const perm = await Notification.requestPermission()
      if (perm !== "granted") {
        setPushPermBlocked(perm === "denied")
        setWebPush(false)
        return
      }
    }
    setPushPermBlocked(false)
    setWebPush(on)
    window.cdp.setUiState({ webPush: on })
    // Real Web Push subscribe/unsubscribe — fires after permission + ui-state are set.
    // Wrapped in try/catch since service workers / pushManager may not exist on every
    // browser; failures here don't undo the ui-state toggle (the user can retry).
    try {
      const reg = await navigator.serviceWorker?.ready
      if (!reg) return
      if (on) {
        const key = await window.cdp.getPushVapidKey?.()
        if (!key) return
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToArrayBuffer(key),
        })
        await window.cdp.subscribePush?.(sub.toJSON() as PushSubscriptionJSON)
      } else {
        const sub = await reg.pushManager.getSubscription()
        if (sub) {
          await window.cdp.unsubscribePush?.(sub.endpoint)
          await sub.unsubscribe()
        }
      }
    } catch (e) {
      console.error("[push] subscribe/unsubscribe failed:", e)
    }
  }, [])

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
      if (caps.web) {
        setIsStandalone((navigator as unknown as { standalone?: boolean }).standalone === true)
        window.cdp.getUiState().then((s) => {
          const granted =
            typeof Notification !== "undefined" && Notification.permission === "granted"
          setWebPush(!!s.webPush && granted)
          setPushPermBlocked(
            typeof Notification !== "undefined" && Notification.permission === "denied",
          )
        })
      }
    }
  }, [open, caps.web])

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
            {/* Remote (CDP) vs Local tabs — the Local toggle is Electron-only */}
            {caps.localTabs && (
              <div className="flex gap-1 rounded-lg bg-foreground/[0.06] p-0.5 text-xs">
                {(["remote", "local"] as const).map((t) => (
                  <button
                    className={
                      "flex-1 rounded-md px-2 py-1 font-medium transition-colors " +
                      (tab === t
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground")
                    }
                    key={t}
                    onClick={() => setTab(t)}
                    type="button"
                  >
                    {t === "remote" ? "Remote (CDP)" : "Local tabs"}
                  </button>
                ))}
              </div>
            )}

            {tab === "remote" && (
              <>
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
                  <div className="mt-3 flex items-start justify-between gap-4">
                    <div className="space-y-0.5">
                      <Label className="text-[13px]">Sync theme to page</Label>
                      <p className="text-[11px] leading-snug text-muted-foreground">
                        Make the remote page follow this theme via prefers-color-scheme.
                      </p>
                    </div>
                    <Switch
                      checked={syncTheme}
                      className="mt-0.5"
                      onCheckedChange={onSyncThemeChange}
                    />
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
                  {caps.web ? (
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-0.5">
                        <Label className={cn("text-[13px]", !isStandalone && "opacity-60")}>
                          Push notifications
                        </Label>
                        <p className="text-[11px] leading-snug text-muted-foreground">
                          Show a browser notification for Teams/Outlook messages when this tab isn't
                          in view.
                          {pushPermBlocked && (
                            <span className="text-destructive"> Blocked in browser settings.</span>
                          )}
                          {!isStandalone && (
                            <span className="block text-amber-600 dark:text-amber-500">
                              Requires installed PWA (Add to Home Screen).
                            </span>
                          )}
                        </p>
                      </div>
                      <Switch
                        checked={webPush}
                        className="mt-0.5"
                        disabled={!isStandalone || pushPermBlocked}
                        onCheckedChange={toggleWebPush}
                      />
                    </div>
                  ) : (
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
                  )}
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
                  {caps.web && (
                    <div className="mt-4 space-y-2 border-border/60 border-t pt-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <Label className="text-[13px]">Connection mode</Label>
                        <span className="text-[10px] text-muted-foreground">
                          Active:{" "}
                          <span className="font-medium">{transportLabel(activeTransport)}</span>
                        </span>
                      </div>
                      <p className="text-[11px] leading-snug text-muted-foreground">
                        How this browser talks to the server. Applied immediately.
                      </p>
                      <div className="grid grid-cols-2 gap-1">
                        {(
                          [
                            {
                              v: "auto",
                              label: "Auto",
                              tip: "Try Fastest, fall back to Streaming, then Basic.",
                            },
                            {
                              v: "ws",
                              label: "Fastest",
                              tip: "WebSocket — full duplex, lowest latency. May be blocked by some proxies.",
                            },
                            {
                              v: "stream",
                              label: "Streaming",
                              tip: "Long-lived POST + SSE. Works on HTTP/2 with unbuffered proxies.",
                            },
                            {
                              v: "batch",
                              label: "Basic",
                              tip: "POST per batch + SSE. Slowest, works everywhere.",
                            },
                          ] as const
                        ).map(({ v, label, tip }) => (
                          <Tooltip key={v}>
                            <TooltipTrigger asChild>
                              <button
                                aria-pressed={inputTransport === v}
                                className={cn(
                                  "rounded-md px-2 py-1.5 text-[12px] font-medium transition-colors",
                                  inputTransport === v
                                    ? "bg-foreground text-background"
                                    : "bg-foreground/[0.06] text-muted-foreground hover:text-foreground",
                                )}
                                onClick={() => {
                                  setInputTransport(v)
                                  localStorage.setItem("inputTransport", v)
                                  // Apply immediately — the bridge tears down WS or
                                  // re-opens it to match the new pref, no reload needed.
                                  window.cdp?.reconfigureInputTransport?.()
                                }}
                                type="button"
                              >
                                {label}
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="top">{tip}</TooltipContent>
                          </Tooltip>
                        ))}
                      </div>
                    </div>
                  )}
                </Card>
              </>
            )}

            {tab === "local" && caps.localTabs && (
              <>
                <Card title="Local tabs">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-0.5">
                      <Label className="text-[13px]">Auto-grant media permissions</Label>
                      <p className="text-[11px] leading-snug text-muted-foreground">
                        Grant mic, camera, screen-share and notifications without a prompt (local
                        session only).
                      </p>
                    </div>
                    <Switch
                      checked={autoGrantLocalMedia}
                      className="mt-0.5"
                      onCheckedChange={onAutoGrantLocalMediaChange}
                    />
                  </div>
                </Card>

                <Card title="Local extensions">
                  <div className="space-y-2.5">
                    {localExtensions.length === 0 && (
                      <p className="text-[11px] leading-snug text-muted-foreground">
                        Load an unpacked MV3 extension into the local-tab session.
                      </p>
                    )}
                    {localExtensions.map((ext) => (
                      <div
                        className="rounded-xl border border-border/60 bg-background/40 p-3"
                        key={ext.path}
                      >
                        <div className="flex items-start gap-2.5">
                          {ext.icon ? (
                            <img alt="" className="size-9 shrink-0 rounded" src={ext.icon} />
                          ) : (
                            <div className="size-9 shrink-0 rounded bg-foreground/10" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-[13px] font-medium">{ext.name}</span>
                              {ext.version && (
                                <span className="shrink-0 text-[11px] text-muted-foreground">
                                  {ext.version}
                                </span>
                              )}
                            </div>
                            {ext.description && (
                              <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                                {ext.description}
                              </p>
                            )}
                            {ext.id && (
                              <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70">
                                ID: {ext.id}
                              </p>
                            )}
                            {!ext.loaded && (
                              <p className="mt-0.5 text-[11px] text-destructive">Not loaded</p>
                            )}
                          </div>
                        </div>
                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                          {ext.popupUrl && (
                            <Button
                              onClick={() => onOpenExtensionUrl(ext.popupUrl as string)}
                              size="sm"
                              variant="outline"
                            >
                              Popup
                            </Button>
                          )}
                          {ext.optionsUrl && (
                            <Button
                              onClick={() => onOpenExtensionUrl(ext.optionsUrl as string)}
                              size="sm"
                              variant="outline"
                            >
                              Options
                            </Button>
                          )}
                          <Button
                            onClick={() => onReloadLocalExtension(ext.path)}
                            size="sm"
                            variant="ghost"
                          >
                            Reload
                          </Button>
                          <Button
                            className="text-destructive hover:text-destructive"
                            onClick={() => setPendingRemoveExt(ext)}
                            size="sm"
                            variant="ghost"
                          >
                            Remove
                          </Button>
                        </div>
                      </div>
                    ))}
                    <Button
                      className="w-full"
                      onClick={onAddLocalExtension}
                      size="sm"
                      variant="outline"
                    >
                      Add unpacked extension…
                    </Button>
                  </div>
                </Card>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog
        onOpenChange={(open) => !open && setPendingRemoveExt(null)}
        open={pendingRemoveExt != null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{pendingRemoveExt?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The extension is unloaded from local tabs and removed from the list. You can add it
              again later from its folder.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingRemoveExt) onRemoveLocalExtension(pendingRemoveExt.path)
                setPendingRemoveExt(null)
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
