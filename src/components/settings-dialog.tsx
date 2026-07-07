import { ArrowReloadHorizontalIcon, Cancel01Icon, Settings01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { readLatencyHudEnabled, setLatencyHudEnabled } from "@/components/latency-hud"
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
import { isPointerFine, usePointerCoarse } from "@/hooks/use-pointer-coarse"
import { getCaps } from "@/lib/caps"
import {
  createBrowserPushDeps,
  ensurePushSubscription,
  removePushSubscription,
} from "@/lib/push-subscribe"
import { parseTier, QUALITY_TIER_KEY, QUALITY_TIERS, type QualityTier } from "@/lib/quality-tier"
import { shouldArmLeaveTimer } from "@/lib/settings-dismiss"
import { removeExclude, type SlackExclude } from "@/lib/slack-excludes"
import type { InputTransportMode } from "@/lib/transport-selector"
import { cn } from "@/lib/utils"
import {
  dispatchVirtualPointerMode,
  parseMode,
  VIRTUAL_POINTER_MODE_KEY,
  type VirtualPointerMode,
} from "@/lib/virtual-pointer"

export type SwitchEffect = "none" | "blur" | "grayscale" | "blur-grayscale"

// One row of the Slack capture health report (t074), as returned by /api/notifications/health.
type SlackHealthRow = {
  // Merged Enterprise Grid org id (`enterprise_id || teamId`, t092) — the unread/mute
  // bucket. The per-device mute key for this workspace is `slack:{groupId}` (t093).
  groupId: string
  teamId: string
  name: string
  status: "healthy" | "degraded" | "unsupported"
  lastError: string | null
}

// Build identity for the About row. Read the Vite defines first; "unknown"/empty means the
// define wasn't injected (only happens on a .git-less web build), so the caller falls back
// to GET /api/version. SHA shows short (7 chars) and never renders blank.
function buildVersion(): string {
  return __APP_VERSION__ || "unknown"
}
function shortSha(sha: string): string {
  return sha && sha !== "unknown" ? sha.slice(0, 7) : "unknown"
}
function defineSha(): string {
  return shortSha(__GIT_SHA__)
}

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
  /** This device's muted sources (muteKeys) and the toggle (t093, web only — the
   *  per-device "Notifications (this device)" card drives them). Inert on Electron. */
  notifMutes: string[]
  onToggleMute: (key: string) => void
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

// The always-shown per-service mute rows (t093): Teams + Outlook key by adapter name.
// Slack workspaces are dynamic (one row per merged Grid org, from health) — added inline.
const ADAPTER_MUTE_ROWS: { key: string; label: string }[] = [
  { key: "teams", label: "Microsoft Teams" },
  { key: "outlook", label: "Outlook" },
]

// One mute toggle in the per-device "Mute on this device" list (t093). A compact row with a
// switch — checked means muted (delivery silenced on this device; the entry still lists).
function MuteRow({
  label,
  muted,
  onToggle,
}: {
  label: string
  muted: boolean
  onToggle: () => void
}) {
  return (
    <li className="flex items-center justify-between gap-3 py-0.5">
      <span className="min-w-0 flex-1 truncate text-[12px]">{label}</span>
      <Switch checked={muted} onCheckedChange={onToggle} />
    </li>
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
  notifMutes,
  onToggleMute,
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
  // Touch is a co-primary input (ADR-0009): a coarse pointer gets explicit dismiss
  // affordances (scrim tap + close button) and never the fine-pointer leave-timer.
  const pointerCoarse = usePointerCoarse()
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
  // Muted Slack channels (Channel Exclude, t072) — stored in server ui-state. Listed here
  // so a mute added from a notification can be reviewed and removed.
  const [slackExcludes, setSlackExcludes] = useState<SlackExclude[]>([])
  // Slack capture health per workspace (t074) — fetched from the server on open.
  const [slackHealth, setSlackHealth] = useState<SlackHealthRow[]>([])
  const removeSlackExclude = useCallback((team: string, channelId: string) => {
    setSlackExcludes((prev) => {
      const next = removeExclude(prev, team, channelId)
      if (next !== prev) window.cdp.setUiState({ slackExcludes: next })
      return next
    })
  }, [])
  // About row: build identity from the Vite defines, with a web-only fetch fallback when a
  // define wasn't injected (a .git-less build). Electron always has the defines so it never fetches.
  const [about, setAbout] = useState<{ version: string; sha: string }>(() => ({
    version: buildVersion(),
    sha: defineSha(),
  }))
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

  // Web-only quality-latency tier (t055). Persists to localStorage (read back on mount)
  // and mirrors into ui-state so the server applies the tier's jpegQuality/everyNthFrame
  // to Page.startScreencast on the next (re)connect. Same persistence shape as the t019
  // transport picker above. The default (balanced) lives in quality-tier.js.
  const [qualityTier, setQualityTier] = useState<QualityTier>(() =>
    typeof localStorage !== "undefined"
      ? parseTier(localStorage.getItem(QUALITY_TIER_KEY))
      : "balanced",
  )

  // Web-only latency HUD toggle (t059). Off by default; persists to localStorage and flips a
  // mounted status-bar readout live via setLatencyHudEnabled. Display-only over t057 metrics.
  const [latencyHud, setLatencyHud] = useState(readLatencyHudEnabled)

  // Virtual-pointer (echo-cursor) visibility mode (t011). Persists server-side via ui-state
  // (localStorage resets on this PWA), read on open below. On change we mirror to ui-state AND
  // dispatch the live event so a mounted EchoOverlay flips without a reload. Shown on all builds.
  const [virtualPointer, setVirtualPointer] = useState<VirtualPointerMode>("auto")

  // The scrollable Sheet body. Its scrollTop persists server-side (settingsScrollTop, t014) so
  // the drawer reopens where it was left, surviving a refresh — restored on open, saved on close.
  const scrollRef = useRef<HTMLDivElement>(null)

  // One subscribe implementation, shared with app.tsx's boot reconcile + foreground
  // recovery (t099) — no second copy of the pushManager.subscribe dance here.
  const pushDeps = useMemo(() => createBrowserPushDeps(), [])

  // Re-subscribe when Settings opens with push on (catches rotation/revocation); idempotent.
  const reValidateSubscription = useCallback(async () => {
    try {
      await ensurePushSubscription(pushDeps)
    } catch (e) {
      console.error("[push] re-validate subscription failed:", e)
    }
  }, [pushDeps])

  const toggleWebPush = useCallback(
    async (on: boolean) => {
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
        if (on) await ensurePushSubscription(pushDeps)
        else await removePushSubscription(pushDeps)
      } catch (e) {
        console.error("[push] subscribe/unsubscribe failed:", e)
      }
    },
    [pushDeps],
  )

  // Suppress the leave-timer while a Select popover (portaled outside the panel)
  // is open — the cursor naturally travels off-panel to reach its options.
  const [selectOpen, setSelectOpen] = useState(false)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // The SW push-subscription-change listener lives in app.tsx now (always mounted, correct
  // container target, reads intent fresh) — see t099. Settings only re-validates on open.

  useEffect(() => {
    if (open) {
      setTest({ status: "idle" })
      window.cdp.getConfig().then((config) => {
        const p = String(config.port)
        setHost(config.host)
        setPort(p)
        setSaved({ host: config.host, port: p })
      })
      // One ui-state load for the whole dialog (t096, A3): virtual-pointer + scroll offset
      // unconditionally, plus the web-only push + excludes fields under the same read — was
      // two separate getUiState() calls in this effect.
      window.cdp.getUiState().then((s) => {
        setVirtualPointer(parseMode(s[VIRTUAL_POINTER_MODE_KEY]))
        const top = Number(s.settingsScrollTop) || 0
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = top
        })
        if (!caps.web) return
        const granted = typeof Notification !== "undefined" && Notification.permission === "granted"
        setWebPush(!!s.webPush && granted)
        setPushPermBlocked(
          typeof Notification !== "undefined" && Notification.permission === "denied",
        )
        // Re-validate the push subscription on open when push is enabled. This catches
        // subscription rotation/expiry and re-subscribes if needed (idempotent).
        if (s.webPush && granted) {
          reValidateSubscription()
        }
        setSlackExcludes(Array.isArray(s.slackExcludes) ? s.slackExcludes : [])
      })
      if (caps.web) {
        setIsStandalone((navigator as unknown as { standalone?: boolean }).standalone === true)
        // Fall back to the server's build identity only when a define is missing (no checkout
        // at build time). A failed fetch leaves the "unknown" placeholder — never blank.
        if (buildVersion() === "unknown" || defineSha() === "unknown") {
          fetch("/api/version")
            .then((r) => r.json())
            .then((v: { version?: string; sha?: string }) => {
              setAbout({ version: v.version || "unknown", sha: shortSha(v.sha || "") })
            })
            .catch(() => {})
        }
        // Through the bridge (not a raw fetch) so E2E responses open correctly (t099).
        // t092: the payload is `{ rows, groups }` (rows merged per Enterprise Grid org;
        // `groups` is the teamId → groupId map consumed by app.tsx). The card reads `rows`.
        window.cdp
          .getNotificationHealth?.()
          .then((data) =>
            setSlackHealth(Array.isArray(data?.rows) ? (data.rows as SlackHealthRow[]) : []),
          )
          .catch(() => setSlackHealth([]))
      }
    }
  }, [open, caps.web, reValidateSubscription])

  const clearLeaveTimer = useCallback(() => {
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current)
      leaveTimer.current = undefined
    }
  }, [])

  // Persist the drawer's scroll offset to ui-state (t014) on the single open→false edge.
  // A layout effect (not onOpenChange) is the one save path because not every close fires
  // onOpenChange: Cmd+, and the extension-url open both flip the `open` prop directly via
  // the parent, and Radix Dialog doesn't re-emit onOpenChange for an externally-driven close.
  // useLayoutEffect runs synchronously after the prop flip but before paint/unmount, so
  // scrollRef still points at the live, scrolled element — scrollTop isn't stale or zeroed.
  // The previous-open ref gates it to the true→false transition (never the initial false).
  const prevOpenRef = useRef(open)
  useLayoutEffect(() => {
    if (prevOpenRef.current && !open && scrollRef.current) {
      window.cdp.setUiState({ settingsScrollTop: scrollRef.current.scrollTop })
    }
    prevOpenRef.current = open
  }, [open])

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
        <TooltipContent side="bottom">Settings</TooltipContent>
      </Tooltip>

      <Sheet modal={false} onOpenChange={onOpenChange} open={open}>
        {/* Coarse-pointer dismiss: a tap outside closes the drawer. There's no hover on
            a finger, so a scrim tap replaces the fine-pointer mouse-leave. Rendered only
            on coarse so the Mac flow (non-modal, live page interactive behind) is unchanged. */}
        {open && pointerCoarse && (
          <button
            aria-label="Close settings"
            className="fixed inset-0 z-40 cursor-default bg-transparent"
            onClick={() => onOpenChange(false)}
            tabIndex={-1}
            type="button"
          />
        )}
        <SheetContent
          aria-describedby={undefined}
          className="flex w-[380px] max-sm:w-full! max-sm:max-w-full! flex-col gap-0 p-0 sm:max-w-[380px]"
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
            // Read the pointer live (per leave event), so a Magic-Keyboard detach flips
            // to the coarse branch with no reload. A coarse pointer never arms the timer,
            // so a finger-lift's synthesized mouseleave can't dismiss the drawer (ADR-0009).
            if (!shouldArmLeaveTimer({ pointerFine: isPointerFine(), committed, selectOpen }))
              return
            clearLeaveTimer()
            leaveTimer.current = setTimeout(() => onOpenChange(false), LEAVE_CLOSE_MS)
          }}
          showCloseButton={false}
          showOverlay={false}
          side="right"
        >
          <SheetHeader className="flex-row items-center justify-between px-5 pt-[max(1.25rem,env(safe-area-inset-top))] pb-1">
            <SheetTitle className="text-sm">Settings</SheetTitle>
            {/* Explicit dismiss — the only manual close on a coarse pointer, where the
                fine-pointer mouse-leave never fires. Clears the leave-timer defensively
                so a pending fine-pointer close can't race the click. ≥44pt on coarse. */}
            <Button
              aria-label="Close settings"
              className="-mr-1.5 text-muted-foreground hover:text-foreground touch-target-end"
              onClick={() => {
                clearLeaveTimer()
                onOpenChange(false)
              }}
              size="icon-xs"
              variant="ghost"
            >
              <HugeiconsIcon className="size-3.5" icon={Cancel01Icon} />
            </Button>
          </SheetHeader>

          <div
            className="flex flex-col gap-3 overflow-y-auto px-5 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
            ref={scrollRef}
          >
            {/* Remote (CDP) vs Local tabs — the Local toggle is Electron-only */}
            {caps.localTabs && (
              <div className="flex gap-1 rounded-lg bg-foreground/[0.06] p-0.5 text-xs">
                {(["remote", "local"] as const).map((t) => (
                  <button
                    className={
                      "flex-1 rounded-md px-2 py-1 font-medium transition-colors coarse:min-h-11 " +
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
                    <div className="grid grid-cols-3 gap-1">
                      {(
                        [
                          { v: "light", label: "Light" },
                          { v: "dark", label: "Dark" },
                          { v: "system", label: "System" },
                        ] as const
                      ).map(({ v, label }) => (
                        <button
                          aria-pressed={theme === v}
                          className={cn(
                            "rounded-md px-2 py-1.5 text-[12px] font-medium transition-colors coarse:min-h-11",
                            theme === v
                              ? "bg-foreground text-background"
                              : "bg-foreground/[0.06] text-muted-foreground hover:text-foreground",
                          )}
                          key={v}
                          onClick={() => onThemeChange(v)}
                          type="button"
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="mt-3.5 space-y-2 border-t border-border/40 pt-3.5">
                    <Label className="text-[13px]">Virtual pointer</Label>
                    <p className="text-[11px] leading-snug text-muted-foreground">
                      Auto: shown only without a mouse/trackpad.
                    </p>
                    <div className="grid grid-cols-3 gap-1">
                      {(
                        [
                          { v: "off", label: "Off" },
                          { v: "on", label: "On" },
                          { v: "auto", label: "Auto" },
                        ] as const
                      ).map(({ v, label }) => (
                        <button
                          aria-pressed={virtualPointer === v}
                          className={cn(
                            "rounded-md px-2 py-1.5 text-[12px] font-medium transition-colors coarse:min-h-11",
                            virtualPointer === v
                              ? "bg-foreground text-background"
                              : "bg-foreground/[0.06] text-muted-foreground hover:text-foreground",
                          )}
                          key={v}
                          onClick={() => {
                            setVirtualPointer(v)
                            window.cdp.setUiState({ [VIRTUAL_POINTER_MODE_KEY]: v })
                            dispatchVirtualPointerMode(v)
                          }}
                          type="button"
                        >
                          {label}
                        </button>
                      ))}
                    </div>
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

                {/* Notifications. Web (PWA across devices): a per-device card — master +
                    push + per-source mutes, all scoped to THIS device (t093). Electron is
                    single-device, so it keeps the one global toggle. */}
                {caps.web ? (
                  <Card title="Notifications (this device)">
                    <div className="space-y-3">
                      {/* Master — the per-device softer mute; off silences everything on this
                          device without unsubscribing push (the push toggle owns the sub). */}
                      <div className="flex items-start justify-between gap-4">
                        <div className="space-y-0.5">
                          <Label className="text-[13px]">Notifications</Label>
                          <p className="text-[11px] leading-snug text-muted-foreground">
                            Master switch for this device. Off silences pushes, toasts, and the
                            badge here — other devices are unaffected.
                          </p>
                        </div>
                        <Switch
                          checked={notificationsEnabled}
                          className="mt-0.5"
                          onCheckedChange={onNotificationsEnabledChange}
                        />
                      </div>

                      {/* Push — owns the subscription + permission grant. */}
                      <div className="flex items-start justify-between gap-4">
                        <div className="space-y-0.5">
                          <Label className={cn("text-[13px]", !isStandalone && "opacity-60")}>
                            Push notifications
                          </Label>
                          <p className="text-[11px] leading-snug text-muted-foreground">
                            Show a notification when the app is backgrounded or closed.
                            {pushPermBlocked && (
                              <span className="text-destructive">
                                {" "}
                                Blocked in browser settings.
                              </span>
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
                          disabled={!isStandalone || pushPermBlocked || !notificationsEnabled}
                          onCheckedChange={toggleWebPush}
                        />
                      </div>

                      {/* Mute on this device — per-service (Teams/Outlook, always shown) +
                          per-Slack-workspace (one row per merged Grid org, from health). */}
                      <div className="space-y-1.5 border-t border-border pt-3">
                        <Label className="text-[13px]">Mute on this device</Label>
                        <p className="text-[11px] leading-snug text-muted-foreground">
                          A muted source still appears in the Inbox (dimmed) — it just won't push,
                          toast, or bump the badge here.
                        </p>
                        <ul className="space-y-0.5 pt-1">
                          {ADAPTER_MUTE_ROWS.map((row) => (
                            <MuteRow
                              key={row.key}
                              label={row.label}
                              muted={notifMutes.includes(row.key)}
                              onToggle={() => onToggleMute(row.key)}
                            />
                          ))}
                          {slackHealth.map((w) => {
                            // A Slack source's muteKey is its merged-workspace groupKey
                            // (see notif-mutes.ts muteKey).
                            const key = `slack:${w.groupId}`
                            return (
                              <MuteRow
                                key={w.groupId}
                                label={w.name}
                                muted={notifMutes.includes(key)}
                                onToggle={() => onToggleMute(key)}
                              />
                            )
                          })}
                        </ul>
                      </div>
                    </div>
                  </Card>
                ) : (
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
                )}

                {caps.web && slackHealth.length > 0 && (
                  <Card title="Slack capture">
                    <ul className="space-y-1">
                      {slackHealth.map((w) => {
                        const dotColor =
                          w.status === "healthy"
                            ? "bg-emerald-500"
                            : w.status === "degraded"
                              ? "bg-amber-500"
                              : "bg-muted-foreground/50"
                        const note =
                          w.status === "healthy"
                            ? "Capturing"
                            : w.status === "degraded"
                              ? "Reconnect — open this workspace"
                              : "Restricted (hijack only)"
                        return (
                          <li className="flex items-center gap-2 text-[12px]" key={w.teamId}>
                            <span className={cn("size-2 shrink-0 rounded-full", dotColor)} />
                            <span className="min-w-0 flex-1 truncate">{w.name}</span>
                            <span className="shrink-0 text-[10px] text-muted-foreground">
                              {note}
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                  </Card>
                )}

                {caps.web && slackExcludes.length > 0 && (
                  <Card title="Muted Slack channels">
                    <div className="space-y-1.5">
                      <p className="text-[11px] leading-snug text-muted-foreground">
                        These channels and DMs are silenced for the content sweep. Unmute to receive
                        their notifications again.
                      </p>
                      <ul className="space-y-1">
                        {slackExcludes.map((ex) => (
                          <li
                            className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-2 py-1"
                            key={`${ex.team}:${ex.channelId}`}
                          >
                            <span className="min-w-0 truncate text-[12px]">
                              {ex.label || ex.channelId}
                            </span>
                            <button
                              className="shrink-0 text-[10px] text-muted-foreground hover:text-foreground"
                              onClick={() => removeSlackExclude(ex.team, ex.channelId)}
                              type="button"
                            >
                              Unmute
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </Card>
                )}

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
                    {/* Force-reconnect the Remote Page (t042) — connect-only, never disconnects.
                        Drives t040's driver via the bridge (web build only; Electron's preload
                        has no `reconnect`, so the button only shows when the verb exists). The
                        44pt coarse tap target comes from the global text-Button bump (index.css). */}
                    {window.cdp?.reconnect && (
                      <Button
                        className="w-full"
                        onClick={() => window.cdp.reconnect?.()}
                        size="sm"
                        variant="outline"
                      >
                        <HugeiconsIcon className="size-3.5" icon={ArrowReloadHorizontalIcon} />
                        Reconnect now
                      </Button>
                    )}
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
                                  "rounded-md px-2 py-1.5 text-[12px] font-medium transition-colors coarse:min-h-11",
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
                  {caps.web && (
                    <div className="mt-4 space-y-2 border-border/60 border-t pt-3">
                      <Label className="text-[13px]">Picture quality</Label>
                      <p className="text-[11px] leading-snug text-muted-foreground">
                        Trade sharpness for responsiveness. Applies on the next reconnect.
                      </p>
                      <div className="grid grid-cols-3 gap-1">
                        {QUALITY_TIERS.map(({ id, label, tip }) => (
                          <Tooltip key={id}>
                            <TooltipTrigger asChild>
                              <button
                                aria-pressed={qualityTier === id}
                                className={cn(
                                  "rounded-md px-2 py-1.5 text-[12px] font-medium transition-colors coarse:min-h-11",
                                  qualityTier === id
                                    ? "bg-foreground text-background"
                                    : "bg-foreground/[0.06] text-muted-foreground hover:text-foreground",
                                )}
                                onClick={() => {
                                  setQualityTier(id)
                                  localStorage.setItem(QUALITY_TIER_KEY, id)
                                  // Mirror into ui-state so the server reads the tier at
                                  // connect, then reconnect to apply the new params.
                                  window.cdp?.setUiState?.({ qualityTier: id })
                                  window.cdp?.reconnect?.()
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
                  {caps.web && (
                    <div className="mt-4 flex items-start justify-between gap-4 border-border/60 border-t pt-3">
                      <div className="space-y-0.5">
                        <Label className="text-[13px]">Latency HUD</Label>
                        <p className="text-[11px] leading-snug text-muted-foreground">
                          Show round-trip time, jitter, frame age and the active transport in the
                          status bar — so a silent slowdown is visible.
                        </p>
                      </div>
                      <Switch
                        checked={latencyHud}
                        className="mt-0.5"
                        onCheckedChange={(on) => {
                          setLatencyHud(on)
                          setLatencyHudEnabled(on)
                        }}
                      />
                    </div>
                  )}
                </Card>

                {/* About — read-only build identity, lowest-priority info at the bottom. */}
                <Card title="About">
                  <div className="space-y-1.5 text-[12px]">
                    <div className="flex items-baseline justify-between gap-4">
                      <span className="text-muted-foreground">Version</span>
                      <span className="font-mono tabular-nums text-foreground">
                        {about.version}
                      </span>
                    </div>
                    <div className="flex items-baseline justify-between gap-4">
                      <span className="text-muted-foreground">Build</span>
                      <span className="font-mono tabular-nums text-foreground">{about.sha}</span>
                    </div>
                  </div>
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
