import { useEffect, useRef } from "react"
import type { LocalTab } from "@/lib/local-tabs"
import { cn } from "@/lib/utils"

// Minimal surface of Electron's <webview> element we drive.
interface WebviewEl extends HTMLElement {
  src: string
  loadURL(url: string): Promise<void>
  reload(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
}

// Imperative controls the toolbar/hotkeys call for the active local tab.
export interface LocalApi {
  navigate(id: string, url: string): void
  back(id: string): void
  forward(id: string): void
  reload(id: string): void
}

interface LocalWebviewsProps {
  tabs: LocalTab[]
  activeId: string | null
  visible: boolean
  apiRef: React.RefObject<LocalApi | null>
  onPatch: (id: string, patch: Partial<LocalTab>) => void
  onOpenUrl: (url: string) => void
}

/**
 * Local tabs as real <webview> elements living in the renderer DOM (one per
 * tab, only the active one shown). Because a webview is an in-page OOPIF, every
 * React overlay (dialog, menu, tooltip, sheet) stacks above the *live* page via
 * normal z-index — no native-view z-order, no freeze. See docs/adr/0005.
 */
export function LocalWebviews({
  tabs,
  activeId,
  visible,
  apiRef,
  onPatch,
  onOpenUrl,
}: LocalWebviewsProps) {
  const els = useRef<Map<string, WebviewEl>>(new Map())

  useEffect(() => {
    apiRef.current = {
      navigate: (id, url) => els.current.get(id)?.loadURL(url),
      back: (id) => {
        const w = els.current.get(id)
        if (w?.canGoBack()) w.goBack()
      },
      forward: (id) => {
        const w = els.current.get(id)
        if (w?.canGoForward()) w.goForward()
      },
      reload: (id) => els.current.get(id)?.reload(),
    }
  }, [apiRef])

  return (
    <div className={cn("absolute inset-0 z-10", !visible && "hidden")}>
      {tabs.map((tab) => (
        <WebviewHost
          active={tab.id === activeId}
          key={tab.id}
          onOpenUrl={onOpenUrl}
          onPatch={onPatch}
          register={(el) => {
            if (el) els.current.set(tab.id, el)
            else els.current.delete(tab.id)
          }}
          tab={tab}
        />
      ))}
    </div>
  )
}

function WebviewHost({
  tab,
  active,
  register,
  onPatch,
  onOpenUrl,
}: {
  tab: LocalTab
  active: boolean
  register: (el: WebviewEl | null) => void
  onPatch: (id: string, patch: Partial<LocalTab>) => void
  onOpenUrl: (url: string) => void
}) {
  const ref = useRef<WebviewEl | null>(null)
  // Initial URL captured once — src is uncontrolled so in-page navigation
  // doesn't reload the view from a state round-trip.
  const initialUrl = useRef(tab.url).current
  const id = tab.id

  // biome-ignore lint/correctness/useExhaustiveDependencies: wire once per webview element
  useEffect(() => {
    const el = ref.current
    if (!el) return
    register(el)
    const nav = () => ({ canGoBack: el.canGoBack(), canGoForward: el.canGoForward() })
    const handlers: Array<[string, (e: Event) => void]> = [
      [
        "page-title-updated",
        (e) => onPatch(id, { title: (e as unknown as { title: string }).title }),
      ],
      [
        "page-favicon-updated",
        (e) => onPatch(id, { favicon: (e as unknown as { favicons: string[] }).favicons?.[0] }),
      ],
      ["did-start-loading", () => onPatch(id, { loading: true })],
      ["did-stop-loading", () => onPatch(id, { loading: false, ...nav() })],
      [
        "did-navigate",
        (e) => onPatch(id, { url: (e as unknown as { url: string }).url, ...nav() }),
      ],
      [
        "did-navigate-in-page",
        (e) => {
          const ev = e as unknown as { url: string; isMainFrame: boolean }
          if (ev.isMainFrame) onPatch(id, { url: ev.url, ...nav() })
        },
      ],
      ["media-started-playing", () => onPatch(id, { audible: true })],
      ["media-paused", () => onPatch(id, { audible: false })],
      ["new-window", (e) => onOpenUrl((e as unknown as { url: string }).url)],
    ]
    for (const [type, fn] of handlers) el.addEventListener(type, fn)
    return () => {
      register(null)
      for (const [type, fn] of handlers) el.removeEventListener(type, fn)
    }
  }, [id])

  return (
    <webview
      allowpopups={true}
      partition="persist:local"
      ref={ref as unknown as React.Ref<HTMLElement>}
      src={initialUrl}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        display: active ? "flex" : "none",
      }}
    />
  )
}
