import { ArrowLeft01Icon, GlobalIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import type { TabInfo } from "@/app"
import { Button } from "@/components/ui/button"
import type { LocalTab } from "@/lib/local-tabs"
import { cn } from "@/lib/utils"

interface Props {
  pins: Pin[]
  tabs: TabInfo[]
  localTabs: LocalTab[]
  activeKind: "cdp" | "local"
  activeTabId: string | null
  localActiveId: string | null
  /** Live tab info per linked pin — favicon/title mirror, same map the sidebar uses. */
  linkedTabByPin: Record<string, TabInfo>
  unreadByPin: Record<string, number>
  unreadByTab: Record<string, number>
  onActivatePin: (pin: Pin) => void
  onSwitchTab: (id: string) => void
  onSwitchLocalTab: (id: string) => void
  onBack: () => void
}

function Favicon({ src }: { src?: string }) {
  if (!src)
    return <HugeiconsIcon className="size-4 shrink-0 text-muted-foreground" icon={GlobalIcon} />
  return (
    <img
      alt=""
      className="size-4 shrink-0 rounded-sm"
      onError={(e) => {
        ;(e.target as HTMLImageElement).style.display = "none"
      }}
      src={src}
    />
  )
}

function Row({
  active,
  badge,
  icon,
  label,
  onClick,
}: {
  active: boolean
  badge?: number
  icon?: string
  label: string
  onClick: () => void
}) {
  return (
    <li>
      <button
        className={cn(
          "flex w-full items-center gap-3 px-4 py-3 text-left touch-target",
          active && "bg-accent",
        )}
        onClick={onClick}
        type="button"
      >
        <Favicon src={icon} />
        <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
        {badge ? (
          <span className="shrink-0 rounded-full bg-primary/15 px-1.5 text-[10px] font-medium text-primary tabular-nums">
            {badge}
          </span>
        ) : null}
      </button>
    </li>
  )
}

/**
 * The Phone Shell's flat tab/pin switcher (t081, ADR-0012 §7): read-and-go only — tap
 * opens the screencast view on that pin/tab. No drag, no context menus, no close; tab
 * management is the wide shell's job. Same ordering as Cmd+1..9 (pins → tabs → locals).
 */
export function PhoneSwitcher({
  pins,
  tabs,
  localTabs,
  activeKind,
  activeTabId,
  localActiveId,
  linkedTabByPin,
  unreadByPin,
  unreadByTab,
  onActivatePin,
  onSwitchTab,
  onSwitchLocalTab,
  onBack,
}: Props) {
  const section = (label: string) => (
    <div className="px-4 pb-1 pt-3 text-[11px] font-medium text-muted-foreground">{label}</div>
  )
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
        <Button
          aria-label="Back to Inbox"
          className="text-muted-foreground"
          onClick={onBack}
          size="icon-xs"
          variant="ghost"
        >
          <HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
        </Button>
        <span className="px-1 text-sm font-semibold">Tabs</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {pins.length > 0 && (
          <section>
            {section("PINNED")}
            <ul>
              {pins.map((p) => {
                const live = linkedTabByPin[p.id]
                return (
                  <Row
                    active={activeKind === "cdp" && !!p.targetId && p.targetId === activeTabId}
                    badge={unreadByPin[p.id]}
                    icon={live?.faviconUrl ?? p.favicon}
                    key={p.id}
                    label={live?.title || p.title || p.url}
                    onClick={() => onActivatePin(p)}
                  />
                )
              })}
            </ul>
          </section>
        )}
        {tabs.length > 0 && (
          <section>
            {section("TABS")}
            <ul>
              {tabs.map((t) => (
                <Row
                  active={activeKind === "cdp" && t.id === activeTabId}
                  badge={unreadByTab[t.id]}
                  icon={t.faviconUrl}
                  key={t.id}
                  label={t.title || t.url}
                  onClick={() => onSwitchTab(t.id)}
                />
              ))}
            </ul>
          </section>
        )}
        {localTabs.length > 0 && (
          <section>
            {section("LOCAL TABS")}
            <ul>
              {localTabs.map((t) => (
                <Row
                  active={activeKind === "local" && t.id === localActiveId}
                  icon={t.favicon}
                  key={t.id}
                  label={t.title || t.url}
                  onClick={() => onSwitchLocalTab(t.id)}
                />
              ))}
            </ul>
          </section>
        )}
        {pins.length === 0 && tabs.length === 0 && localTabs.length === 0 && (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            No open tabs on the remote browser
          </div>
        )}
      </div>
    </div>
  )
}
