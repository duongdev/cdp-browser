import { Activity03Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useEffect, useState } from "react"
import { getLatencySnapshot, type LatencySnapshot } from "@/lib/latency-metrics"
import type { InputTransportMode } from "@/lib/transport-selector"

/** Fired by the settings toggle so a mounted HUD flips on/off live without prop-drilling. */
const LATENCY_HUD_EVENT = "latencyhud:change"

// t100: the enabled flag is durable per-device in server ui-state now, not localStorage (which
// resets on the iPad PWA). This module holds only the live in-memory value + a change event so a
// mounted HUD flips instantly; app.tsx seeds it from ui-state at boot, and the settings toggle
// persists via setUiState. No storage here.
let hudEnabled = false

/** The live in-memory flag (seeded from ui-state at boot). Off until ui-state resolves. */
export function readLatencyHudEnabled(): boolean {
  return hudEnabled
}

/** Apply the flag live: update the in-memory value and flip any mounted HUD. Persistence is the
 *  caller's ui-state write (setUiState({ latencyHud })) — this is display-apply only. */
export function setLatencyHudEnabled(on: boolean): void {
  hudEnabled = on
  window.dispatchEvent(new CustomEvent(LATENCY_HUD_EVENT, { detail: on }))
}

/** Subscribe to the persisted on/off flag, flipping live on the toggle event. The status bar
 *  uses this to stay mounted as the HUD's home; `active=false` (no HUD slot) pins it off. */
export function useLatencyHudEnabled(active = true): boolean {
  const [enabled, setEnabled] = useState(() => active && readLatencyHudEnabled())
  useEffect(() => {
    if (!active) {
      setEnabled(false)
      return
    }
    setEnabled(readLatencyHudEnabled())
    const onChange = (e: Event) => setEnabled((e as CustomEvent<boolean>).detail)
    window.addEventListener(LATENCY_HUD_EVENT, onChange)
    return () => window.removeEventListener(LATENCY_HUD_EVENT, onChange)
  }, [active])
  return enabled
}

const PLACEHOLDER = "—"

/** Round a metric to whole ms with a unit, or the neutral placeholder when not ready. */
function fmtMs(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? `${Math.round(v)}ms` : PLACEHOLDER
}

const TRANSPORT_LABEL: Record<InputTransportMode, string> = {
  auto: "Auto",
  ws: "WS",
  stream: "Stream",
  batch: "Batch",
}

export interface LatencyHudStrings {
  rtt: string
  jitter: string
  frameAge: string
  transport: string
  /** True when input settled on the `batch` floor — i.e. both fast paths (WS and the
   *  streaming POST channel) failed to activate, the silent symptom of a buffering proxy.
   *  Drives the HUD's "on fallback" cue that points the operator at the proxy guide. */
  transportFallback: boolean
}

/** Pure formatter: snapshot + active transport → display strings. Rounds to whole ms,
 *  maps the transport enum to a short label, and degrades bad/missing inputs to `—`. */
export function formatLatencyHud(
  snapshot: LatencySnapshot,
  transport: InputTransportMode | undefined,
): LatencyHudStrings {
  return {
    rtt: fmtMs(snapshot.rtt),
    jitter: fmtMs(snapshot.jitter),
    frameAge: fmtMs(snapshot.frameAge),
    transport: transport ? TRANSPORT_LABEL[transport] : PLACEHOLDER,
    transportFallback: transport === "batch",
  }
}

/** Refresh cadence — 3Hz is enough to feel live while costing ~nothing (display-only). */
const REFRESH_MS = 333

/**
 * Self-contained latency readout for the status bar (t059). Off by default; it owns its
 * enabled flag (localStorage, web-only) so the status bar stays dumb. When on, it polls the
 * always-on t057 metrics on a slow interval — it issues no pings/frames/network of its own —
 * and shows RTT / jitter / frame age / active transport so a silent proxy demotion is visible.
 */
export function LatencyHud() {
  const enabled = useLatencyHudEnabled()
  const [snapshot, setSnapshot] = useState<LatencySnapshot>(getLatencySnapshot)
  const [transport, setTransport] = useState<InputTransportMode | undefined>(() =>
    window.cdp?.getActiveTransport?.(),
  )

  useEffect(() => {
    if (!enabled) return
    const tick = () => {
      setSnapshot(getLatencySnapshot())
      setTransport(window.cdp?.getActiveTransport?.())
    }
    tick()
    const id = setInterval(tick, REFRESH_MS)
    return () => clearInterval(id)
  }, [enabled])

  if (!enabled) return null

  const f = formatLatencyHud(snapshot, transport)
  return (
    <div className="ml-auto flex items-center gap-2 pl-2 font-mono text-[10px] tabular-nums text-muted-foreground/80 select-none">
      <HugeiconsIcon className="size-3 shrink-0 text-muted-foreground/60" icon={Activity03Icon} />
      <span title="Round-trip time">{f.rtt}</span>
      <span className="text-muted-foreground/50">·</span>
      <span title="Jitter">±{f.jitter}</span>
      <span className="text-muted-foreground/50">·</span>
      <span title="Screencast frame age">{f.frameAge}</span>
      <span className="text-muted-foreground/50">·</span>
      {f.transportFallback ? (
        <span
          className="font-semibold text-amber-500"
          title="Input on the slow fallback — the fast path (WS / streaming) was blocked, likely a buffering proxy. See docs/guides/proxy-buffering-config.md"
        >
          {f.transport} ⚠
        </span>
      ) : (
        <span className="font-semibold" title="Active transport">
          {f.transport}
        </span>
      )}
    </div>
  )
}
