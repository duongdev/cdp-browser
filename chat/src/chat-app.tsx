import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ReloadIcon,
  Settings02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { CommandPalette } from "./components/command-palette"
import { ConversationList } from "./components/conversation-list"
import { ProfileDialog, type ProfileTarget } from "./components/profile-dialog"
import { PromptDialog, prompt } from "./components/prompt-dialog"
import { SettingsSheet } from "./components/settings-sheet"
import { ShortcutOverlay } from "./components/shortcut-overlay"
import { type ThreadFocus, type ThreadHandle, ThreadView } from "./components/thread-view"
import { routeKey } from "./lib/chat-keys"
import { parsePath, pathFor } from "./lib/chat-route"
import { chatShell } from "./lib/chat-shell"
import { buildActions, type ChatAction, type ChatContext } from "./lib/command-registry"
import {
  conversationLabel,
  isMutedNow,
  isUnread,
  knownFolders,
  knownLabels,
  navigableConversations,
  previewLine,
  type ReadOverride,
  toggleLabel,
} from "./lib/conversation-view"
import type { NamePref } from "./lib/display-name"
import { newlyArrived } from "./lib/notify-new"
import { markReadLocal, type TeamsConversation } from "./lib/teams-client"
import { EMPTY_KEEPALIVE, type KeepAliveState, openThread } from "./lib/thread-keepalive"
import { useChatSettings } from "./lib/use-chat-settings"
import { useConvPrefs } from "./lib/use-conv-prefs"

// Reactive wide/narrow gate (t129). Wide (≥768px) shows the two-pane list+thread; narrow stacks
// list → thread → back. matchMedia over a resize listener — it fires only on the boundary cross.
function useIsWide() {
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 768px)").matches)
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)")
    const on = () => setWide(mq.matches)
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [])
  return wide
}

function HeaderButton({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string
  icon: typeof Settings02Icon
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className="text-muted-foreground"
          disabled={disabled}
          onClick={onClick}
          size="icon-sm"
          variant="ghost"
        >
          <HugeiconsIcon className="size-4" icon={icon} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function AppHeader({
  onOpenSettings,
  canBack,
  canForward,
}: {
  onOpenSettings: () => void
  canBack: boolean
  canForward: boolean
}) {
  // Electron-only browser-style nav. Reload force-fetches a fresh build (main); back/forward walk
  // the SPA history directly (window.history — Electron's navigationHistory ignores pushState).
  const shell = chatShell()
  return (
    <header className="titlebar flex h-12 shrink-0 items-center justify-end gap-0.5 border-border border-b px-4">
      <TooltipProvider delayDuration={300}>
        <HeaderButton icon={Settings02Icon} label="Settings" onClick={onOpenSettings} />
        {shell && (
          <>
            <HeaderButton icon={ReloadIcon} label="Refresh" onClick={() => shell.reload()} />
            <HeaderButton
              disabled={!canBack}
              icon={ArrowLeft01Icon}
              label="Back"
              onClick={() => window.history.back()}
            />
            <HeaderButton
              disabled={!canForward}
              icon={ArrowRight01Icon}
              label="Forward"
              onClick={() => window.history.forward()}
            />
          </>
        )}
      </TooltipProvider>
    </header>
  )
}

// A placeholder conversation for a push deep-link — we only know the id. ThreadView fetches history
// + sender names by id; a later list tap replaces this with the real row (title etc.).
// ponytail: header shows a kind-label ("Direct message") until then — the deep-link only carries id.
function stubConversation(id: string): TeamsConversation {
  return {
    id,
    kind: "oneOnOne",
    topic: null,
    lastMessageId: null,
    lastMessageVersion: 0,
    lastMessageTs: null,
    lastMessagePreview: "",
    readTs: 0,
    lastMessageFromMe: false,
    unreadSticky: false,
    muted: false,
  }
}

// The 'g …' two-key sequence window (t152): after a bare `g`, the next key within this window is the
// second half (g i → inbox). Mirrors Linear/Gmail.
const G_SEQUENCE_MS = 1000

/** Root of the standalone Teams chat app (t128/t129, ADR-0019). List+pane: wide shows the
 *  conversation list beside the thread; narrow shows one at a time with a back button.
 *
 *  Instant switch (t132): every opened conversation's thread stays mounted (its own pane, hidden
 *  when inactive via display:none) so switching is a pure visibility toggle — no remount, no
 *  refetch, scroll retained. The pure keep-alive model (`openThread`) decides which panes mount and
 *  which is active + evicts the least-recently-viewed past the cap; this component only renders.
 *
 *  Keyboard-first (t152): a global keydown router (`routeKey`) drives list/thread focus (j/k, arrows),
 *  the ⌘K palette, the `?` overlay, and message actions on the focused thread message — all through
 *  the pure command registry, so the palette and overlay share one source of truth. */
export function ChatApp() {
  const isWide = useIsWide()
  const [keepAlive, setKeepAlive] = useState<KeepAliveState>(EMPTY_KEEPALIVE)
  // Conversation metadata by id, so an inactive-but-mounted pane can still render. Grows only with
  // distinct conversations opened in a session (tiny objects) — not pruned on eviction.
  const [convById, setConvById] = useState<Record<string, TeamsConversation>>({})
  // Phone only: which surface is on screen. The thread panes stay mounted while the list shows.
  const [phoneView, setPhoneView] = useState<"list" | "thread">("list")

  // The live conversation list (t152): captured from the list component (override-applied, t155) so
  // keyboard j/k has an order to walk and the palette can jump to any of them. Also feeds the
  // late-metadata swap below.
  const [conversations, setConversations] = useState<TeamsConversation[]>([])
  // Latest list by ref, so patchConvRead can stay STABLE (deps []). If it depended on
  // `conversations`, every list report would mint a new openConversationById and re-run the boot
  // effect (URL still /chat/c/{id}) — which re-laid a "read" override in a loop that clobbered a
  // just-made mark-unread (the iteration-2→3 bug).
  const conversationsRef = useRef<TeamsConversation[]>([])
  // Desktop notifications for new incoming messages (PSN-91). The list poll is the signal source;
  // `seenTsRef` tracks the last-seen ts per conversation so `newlyArrived` fires once per message.
  // Only when the window is unfocused (backgrounded) — an open, focused app doesn't need a toast.
  // `openConvRef` lets a notification click jump to the conversation (set after openConversationById).
  const seenTsRef = useRef<Map<string, number>>(new Map())
  const openConvRef = useRef<(id: string) => void>(() => {})
  const notifEnabledRef = useRef(true)
  const onConversations = useCallback((list: TeamsConversation[]) => {
    conversationsRef.current = list
    setConversations(list)
    const { arrived, seen } = newlyArrived(seenTsRef.current, list)
    seenTsRef.current = seen
    const shell = chatShell()
    if (arrived.length > 0 && !document.hasFocus()) {
      for (const c of arrived) {
        if (shell) {
          if (notifEnabledRef.current) {
            // Electron shell: fire through the native main process (CDP-Browser mechanism).
            shell.notify({ title: conversationLabel(c), body: previewLine(c), convId: c.id })
          }
        } else if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          const n = new Notification(conversationLabel(c), { body: previewLine(c), tag: c.id })
          n.onclick = () => {
            window.focus()
            openConvRef.current(c.id)
          }
        }
      }
    }
    // Dock badge in the Electron shell mirrors the unread count (the web PWA drives its own
    // badge via the service worker's setAppBadge).
    if (shell) {
      const badge = notifEnabledRef.current ? list.filter((c) => isUnread(c)).length : 0
      shell.setBadge(badge)
    }
    // Late-arriving list metadata (t150 fix): a deep-linked pane mounts with a stub conversation
    // (id only). When the list loads/merges, swap any tracked entry for the real object so the
    // thread header picks up the resolved title. Only ids already tracked are stored.
    setConvById((m) => {
      let next = m
      for (const c of list) {
        if (m[c.id] && m[c.id] !== c) {
          if (next === m) next = { ...m }
          next[c.id] = c
        }
      }
      return next
    })
  }, [])

  // Optimistic read-state overrides by conv id (t155). The visible rows live in ConversationList's
  // OWN state, so the override map is passed down and applied THERE (patching the app-side copy
  // never reached the screen — the iteration-2 bug). `patchConvRead` lays an override (instant dot
  // change, poll-proof via applyReadOverride's max-merge) and, when `persist`, POSTs
  // /api/teams/read-local so the server agrees (opens persist too — a kept-alive re-open has no
  // history load to write local_read for it).
  const [readOverrides, setReadOverrides] = useState<Record<string, ReadOverride>>({})
  const patchConvRead = useCallback((id: string, action: "read" | "unread", persist: boolean) => {
    const c = conversationsRef.current.find((x) => x.id === id)
    // Fallback for a not-yet-listed conv (push deep-link): "now" covers everything currently shown.
    const ts = c?.lastMessageTs ?? Date.now()
    setReadOverrides((m) => ({ ...m, [id]: { action, ts } }))
    if (persist) markReadLocal(id, action, ts)
  }, [])

  // Renderer-owned back/forward for the Electron header (PSN-91). Electron's webContents
  // navigationHistory doesn't count same-document pushState entries, so the SPA routes are walked
  // with window.history and enable/disable is tracked by a self-managed index stamped into
  // history.state (the History API has no canGoForward). `pushPath` is the single push seam.
  const navIdx = useRef(0)
  const navMax = useRef(0)
  const [canNav, setCanNav] = useState({ back: false, forward: false })
  useEffect(() => {
    // Stamp the base entry so popstate can read a position back to it.
    window.history.replaceState({ idx: 0 }, "")
  }, [])
  const pushPath = useCallback((path: string) => {
    if (window.location.pathname === path) return
    navIdx.current += 1
    navMax.current = navIdx.current
    window.history.pushState({ idx: navIdx.current }, "", path)
    setCanNav({ back: navIdx.current > 0, forward: false })
  }, [])

  // The URL is the state (t150): `/chat/c/{id}` is an open conversation, `/chat/` is the list.
  // A user-driven open pushes; a popstate-driven one replays history without re-pushing.
  const openConversation = useCallback(
    (conv: TeamsConversation) => {
      setConvById((m) => (m[conv.id] === conv ? m : { ...m, [conv.id]: conv }))
      setKeepAlive((s) => openThread(s, conv.id))
      setPhoneView("thread")
      // persist=true: a kept-alive pane re-open doesn't refetch history (whose non-poll load is the
      // other server-side read write), so the open itself must clear a mark-unread sentinel durably.
      patchConvRead(conv.id, "read", true)
      pushPath(pathFor(conv.id))
    },
    [patchConvRead, pushPath],
  )

  const openConversationById = useCallback(
    (id: string, push = true) => {
      setConvById((m) => (m[id] ? m : { ...m, [id]: stubConversation(id) }))
      setKeepAlive((s) => openThread(s, id))
      setPhoneView("thread")
      patchConvRead(id, "read", true)
      if (push) pushPath(pathFor(id))
    },
    [patchConvRead, pushPath],
  )
  openConvRef.current = openConversationById

  // Electron shell notification click → open the conversation (main posts the convId back).
  useEffect(() => {
    chatShell()?.onNotificationActivate((id) => openConversationById(id))
  }, [openConversationById])

  // Push deep-link (t147): a cold tap lands with ?conv=<id> in the URL; a warm tap (window already
  // open) arrives as an SW postMessage { type:"open-conv", convId }. Both open that conversation;
  // strip ?conv= after consuming so a refresh doesn't reopen.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const conv = params.get("conv")
    if (conv) {
      openConversationById(conv)
      params.delete("conv")
      const qs = params.toString()
      window.history.replaceState(
        null,
        "",
        window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
      )
    }
    const sw = navigator.serviceWorker
    if (!sw) return
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "open-conv" && typeof e.data.convId === "string")
        openConversationById(e.data.convId)
    }
    sw.addEventListener("message", onMessage)
    return () => sw.removeEventListener("message", onMessage)
  }, [openConversationById])

  // Boot from the URL + follow browser back/forward (t150). On boot, a `/chat/c/{id}` path opens
  // that conversation (ThreadView fetches by id alone, with its own error state for a gone id).
  // popstate replays whatever the current path encodes: an id opens its thread, the list path
  // pops back — on phone that back-swipe returns to the list.
  useEffect(() => {
    const route = parsePath(window.location.pathname)
    if (route) openConversationById(route.convId, false)
    const onPop = (e: PopStateEvent) => {
      // Track position from the stamped index so the header's back/forward can enable correctly.
      const idx = (e.state as { idx?: number } | null)?.idx ?? 0
      navIdx.current = idx
      setCanNav({ back: idx > 0, forward: idx < navMax.current })
      const r = parsePath(window.location.pathname)
      if (r) openConversationById(r.convId, false)
      else setPhoneView("list")
    }
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [openConversationById])

  // `u` toggles the focused/open conversation's read state (t155). Read → unread, else → read.
  // Reads the ref (not state) so the decision always sees the just-reported, override-applied list.
  const toggleReadUnread = useCallback(
    (id: string | null) => {
      if (!id) return
      const c = conversationsRef.current.find((x) => x.id === id)
      patchConvRead(id, c && isUnread(c) ? "read" : "unread", true)
    },
    [patchConvRead],
  )

  const backToList = useCallback(() => {
    setPhoneView("list")
    pushPath("/chat/")
  }, [pushPath])

  // ── Keyboard-first navigation (t152) ────────────────────────────────────────────────────────
  // List cursor + the active thread pane's handle + its reported focused message. The list cursor
  // is by id (survives a merge that reorders); on phone the "list" view is the list, on wide it's
  // always visible beside the thread.
  const [focusedConvId, setFocusedConvId] = useState<string | null>(null)
  const activeThreadRef = useRef<ThreadHandle | null>(null)
  const [threadFocus, setThreadFocus] = useState<ThreadFocus | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [overlayOpen, setOverlayOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { settings, update: updateSettings } = useChatSettings()
  notifEnabledRef.current = settings.notificationsEnabled
  // Local conversation prefs (t156): labels/folder/mute (shared server-side) + per-device folder
  // collapse state. Applied over the list rows inside ConversationList (poll-proof, like read overrides).
  const {
    prefs,
    patch: patchPrefs,
    collapsed,
    toggleFolderCollapsed,
    folderOrder,
    setFolderOrder,
  } = useConvPrefs()
  const pendingG = useRef(false)
  const gTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // The surface a keystroke acts on: the thread only when one is actually OPEN and on screen (on
  // phone, when the thread view is showing). Otherwise the list — including the wide layout's boot
  // state (t152 fix: `view` was "thread" there with no pane open, so j/k drove a null thread handle
  // and the list cursor never moved).
  const threadOpen = !!keepAlive.active && (isWide || phoneView === "thread")
  const view: "list" | "thread" = threadOpen ? "thread" : "list"

  // The list in the exact order it's shown (folder-grouped, collapsed folders excluded) — the order
  // j/k must walk so the focus ring never lands on an off-screen row (t157).
  const navConversations = useMemo(
    () => navigableConversations(conversations, collapsed),
    [conversations, collapsed],
  )

  // Move the list cursor by delta (down = next, i.e. further down the list).
  const moveListFocus = useCallback(
    (delta: 1 | -1) => {
      setFocusedConvId((cur) => {
        if (navConversations.length === 0) return cur
        const i = cur ? navConversations.findIndex((c) => c.id === cur) : -1
        if (i === -1) return navConversations[0].id
        const next = Math.min(navConversations.length - 1, Math.max(0, i + delta))
        return navConversations[next].id
      })
    },
    [navConversations],
  )

  // Switch the OPEN conversation by delta (⌥↑/⌥↓): walk the visible list order from the current
  // active/focused row and open its neighbor. Works from the thread view too.
  const switchConversation = useCallback(
    (delta: 1 | -1) => {
      if (navConversations.length === 0) return
      const cur = keepAlive.active ?? focusedConvId
      const i = cur ? navConversations.findIndex((c) => c.id === cur) : -1
      const next = i === -1 ? 0 : Math.min(navConversations.length - 1, Math.max(0, i + delta))
      openConversation(navConversations[next])
    },
    [navConversations, keepAlive.active, focusedConvId, openConversation],
  )

  // Open the Nth visible conversation (⌘1..⌘9). Out-of-range indexes are a no-op.
  const openConvByIndex = useCallback(
    (n: number) => {
      const conv = navConversations[n - 1]
      if (conv) openConversation(conv)
    },
    [navConversations, openConversation],
  )

  const clearPendingG = useCallback(() => {
    pendingG.current = false
    if (gTimer.current) clearTimeout(gTimer.current)
  }, [])

  // The context the palette + key router read. threadFocus drives message-action availability.
  const ctx: ChatContext = useMemo(
    () => ({
      view,
      focusedConversationId: view === "list" ? focusedConvId : keepAlive.active,
      focusedMessageId: threadFocus?.id ?? null,
      isOwnMessage: threadFocus?.isOwn ?? false,
    }),
    [view, focusedConvId, keepAlive.active, threadFocus],
  )

  // The command registry (t152): pure data, effects injected here. Jump-to-conversation rows are
  // generated per conversation; the rest are static app/message actions. Only actions that work
  // TODAY are listed — no dead entries (settings/mark-read land in later workstreams).
  const actions: ChatAction[] = useMemo(() => {
    const jumps: ChatAction[] = conversations.slice(0, 50).map((c) => {
      const original =
        c.title?.trim() || c.topic?.trim() || (c.kind === "self" ? "Notes" : "Direct message")
      return {
        id: `jump:${c.id}`,
        // Local rename (t168): show "Custom (Original)" so the palette filter matches BOTH names.
        label: c.customTitle ? `${c.customTitle} (${original})` : original,
        group: "Conversation",
        run: () => openConversation(c),
      }
    })
    return buildActions([
      { id: "go-inbox", label: "Go to inbox", group: "Navigation", keys: "g i", run: backToList },
      {
        id: "focus-next",
        label: "Focus next",
        group: "Navigation",
        keys: "j",
        run: () => (view === "list" ? moveListFocus(1) : activeThreadRef.current?.focusNext()),
      },
      {
        id: "focus-prev",
        label: "Focus previous",
        group: "Navigation",
        keys: "k",
        run: () => (view === "list" ? moveListFocus(-1) : activeThreadRef.current?.focusPrev()),
      },
      {
        id: "conv-next",
        label: "Next conversation",
        group: "Navigation",
        keys: "⌘⇧]",
        run: () => switchConversation(1),
      },
      {
        id: "conv-prev",
        label: "Previous conversation",
        group: "Navigation",
        keys: "⌘⇧[",
        run: () => switchConversation(-1),
      },
      {
        id: "jump-index",
        label: "Jump to conversation 1–9",
        group: "Navigation",
        keys: "⌘1–9",
        run: () => openConvByIndex(1),
      },
      {
        id: "focus-input",
        label: "Focus message input",
        group: "Message",
        keys: "i  /",
        when: (c) => c.view === "thread",
        run: () => activeThreadRef.current?.focusComposer(),
      },
      {
        id: "open-settings",
        label: "Open settings",
        group: "App",
        keys: "⌘,",
        run: () => setSettingsOpen(true),
      },
      {
        id: "shortcuts",
        label: "Keyboard shortcuts",
        group: "App",
        keys: "?",
        run: () => setOverlayOpen(true),
      },
      {
        id: "mark-read",
        label: "Mark as read",
        group: "Conversation",
        keys: "u",
        when: (c) => {
          const conv = conversations.find((x) => x.id === c.focusedConversationId)
          return !!conv && isUnread(conv)
        },
        run: () =>
          ctx.focusedConversationId && patchConvRead(ctx.focusedConversationId, "read", true),
      },
      {
        id: "mark-unread",
        label: "Mark as unread",
        group: "Conversation",
        // No overlay `keys` hint — `u` is a single toggle documented on "Mark as read" (the overlay
        // lists it once; both palette actions still run the toggle). Palette shows the plain label.
        when: (c) => {
          const conv = conversations.find((x) => x.id === c.focusedConversationId)
          return !!conv && !isUnread(conv)
        },
        run: () =>
          ctx.focusedConversationId && patchConvRead(ctx.focusedConversationId, "unread", true),
      },
      // Per-conversation mute (t156). Label flips with the focused conversation's current state.
      {
        id: "mute-conv",
        label: isMutedNow(prefs[ctx.focusedConversationId ?? ""])
          ? "Unmute conversation"
          : "Mute conversation",
        group: "Conversation",
        when: (c) => !!c.focusedConversationId,
        run: () => {
          // ⌘K quick toggle mutes until-unmute (t167); the row menu has the timed presets.
          const id = ctx.focusedConversationId
          if (id) patchPrefs(id, { muted: !isMutedNow(prefs[id]) })
        },
      },
      // Rename chat (t168): local-only custom title; blank resets to the original.
      {
        id: "rename-conv",
        label: "Rename chat…",
        group: "Conversation",
        when: (c) => !!c.focusedConversationId,
        run: async () => {
          const id = ctx.focusedConversationId
          if (!id) return
          const name = await prompt({
            title: "Rename chat",
            description: "Leave blank to reset to the original name.",
            initialValue: prefs[id]?.customTitle ?? "",
            placeholder: "Chat name",
          })
          if (name !== null) patchPrefs(id, { customTitle: name.trim() || null })
        },
      },
      // Move to folder (t156). Palette-simple: prompt for a folder name (blank clears). The row menu
      // has the full submenu of existing folders; this is the keyboard-driven quick path.
      {
        id: "move-folder",
        label: "Move to folder…",
        group: "Conversation",
        when: (c) => !!c.focusedConversationId,
        run: async () => {
          const id = ctx.focusedConversationId
          if (!id) return
          const existing = knownFolders(prefs)
          const name = await prompt({
            title: "Move to folder",
            description: existing.length
              ? `Existing folders: ${existing.join(", ")}. Leave blank to remove from folder.`
              : "Leave blank to remove from folder.",
            initialValue: prefs[id]?.folder ?? "",
            placeholder: "Folder name",
          })
          if (name === null) return
          patchPrefs(id, { folder: name.trim() || null })
        },
      },
      ...jumps,
      {
        id: "msg-react",
        label: "React to message",
        group: "Message",
        keys: "r",
        when: (c) => c.view === "thread" && !!c.focusedMessageId,
        run: () => activeThreadRef.current?.command("react"),
      },
      {
        id: "msg-edit",
        label: "Edit message",
        group: "Message",
        keys: "e",
        when: (c) => c.view === "thread" && !!c.isOwnMessage,
        run: () => activeThreadRef.current?.command("edit"),
      },
      {
        id: "msg-delete",
        label: "Delete message",
        group: "Message",
        keys: "⌫",
        when: (c) => c.view === "thread" && !!c.isOwnMessage,
        run: () => activeThreadRef.current?.command("delete"),
      },
      // ── Group B: new-feature commands (thread context) ─────────────────────────
      {
        id: "msg-reply",
        label: "Reply to message",
        group: "Message",
        when: (c) => c.view === "thread" && !!c.focusedMessageId,
        run: () => activeThreadRef.current?.replyFocused(),
      },
      {
        id: "msg-jump-unread",
        label: "Jump to unread",
        group: "Message",
        when: (c) => c.view === "thread",
        run: () => activeThreadRef.current?.jumpToUnread(),
      },
      {
        id: "msg-attach",
        label: "Attach files",
        group: "Message",
        when: (c) => c.view === "thread",
        run: () => activeThreadRef.current?.openFilePicker(),
      },
      // ── Group A: settings toggles ───────────────────────────────────────────────
      {
        id: "theme-light",
        label: "Theme: Light",
        group: "App",
        when: () => settings.theme !== "light",
        run: () => updateSettings({ theme: "light" }),
      },
      {
        id: "theme-dark",
        label: "Theme: Dark",
        group: "App",
        when: () => settings.theme !== "dark",
        run: () => updateSettings({ theme: "dark" }),
      },
      {
        id: "theme-system",
        label: "Theme: System",
        group: "App",
        when: () => settings.theme !== "system",
        run: () => updateSettings({ theme: "system" }),
      },
      {
        id: "density-comfortable",
        label: "Density: Comfortable",
        group: "App",
        when: () => settings.density !== "comfortable",
        run: () => updateSettings({ density: "comfortable" }),
      },
      {
        id: "density-compact",
        label: "Density: Compact",
        group: "App",
        when: () => settings.density !== "compact",
        run: () => updateSettings({ density: "compact" }),
      },
      {
        id: "names-full",
        label: "Names: Full name",
        group: "App",
        when: () => settings.nameDisplay !== "full",
        run: () => updateSettings({ nameDisplay: "full" }),
      },
      {
        id: "names-first",
        label: "Names: First name",
        group: "App",
        when: () => settings.nameDisplay !== "first",
        run: () => updateSettings({ nameDisplay: "first" }),
      },
      {
        id: "notifications-on",
        label: "Notifications: On",
        group: "App",
        when: () => !settings.notificationsEnabled,
        run: () => updateSettings({ notificationsEnabled: true }),
      },
      {
        id: "notifications-off",
        label: "Notifications: Off",
        group: "App",
        when: () => settings.notificationsEnabled,
        run: () => updateSettings({ notificationsEnabled: false }),
      },
      // ── Group C: conversation management (list / thread context) ───────────────
      // Add label: one command per known label (toggle). Blank slate: no-op (prompt handles creation).
      ...knownLabels(prefs).map(
        (lbl): ChatAction => ({
          id: `label:${lbl}`,
          label: prefs[ctx.focusedConversationId ?? ""]?.labels?.includes(lbl)
            ? `Remove label "${lbl}"`
            : `Add label "${lbl}"`,
          group: "Conversation",
          when: (c) => !!c.focusedConversationId,
          run: () => {
            const id = ctx.focusedConversationId
            if (!id) return
            const cur = prefs[id]?.labels ?? []
            patchPrefs(id, { labels: toggleLabel(cur, lbl) })
          },
        }),
      ),
      {
        id: "add-label-new",
        label: "Add label…",
        group: "Conversation",
        when: (c) => !!c.focusedConversationId,
        run: async () => {
          const id = ctx.focusedConversationId
          if (!id) return
          const name = await prompt({
            title: "Add label",
            description: "Enter a label name to add or remove it.",
            initialValue: "",
            placeholder: "Label name",
          })
          if (!name) return
          const cur = prefs[id]?.labels ?? []
          patchPrefs(id, { labels: toggleLabel(cur, name) })
        },
      },
      {
        id: "collapse-all-folders",
        label: "Collapse all folders",
        group: "Conversation",
        when: () => knownFolders(prefs).some((f) => !collapsed.has(f)),
        run: () => {
          for (const f of knownFolders(prefs)) {
            if (!collapsed.has(f)) toggleFolderCollapsed(f)
          }
        },
      },
      {
        id: "expand-all-folders",
        label: "Expand all folders",
        group: "Conversation",
        when: () => knownFolders(prefs).some((f) => collapsed.has(f)),
        run: () => {
          for (const f of knownFolders(prefs)) {
            if (collapsed.has(f)) toggleFolderCollapsed(f)
          }
        },
      },
    ])
  }, [
    conversations,
    openConversation,
    backToList,
    view,
    moveListFocus,
    patchConvRead,
    ctx,
    prefs,
    patchPrefs,
    switchConversation,
    openConvByIndex,
    settings,
    updateSettings,
    collapsed,
    toggleFolderCollapsed,
  ])

  // Global keydown router. Suppressed while the palette/overlay is open (their own Dialog owns keys).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (paletteOpen || overlayOpen) return
      const intent = routeKey(
        {
          key: e.key,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          shiftKey: e.shiftKey,
          target: e.target,
        },
        // Composer focus is read from the active pane, not tracked in React state (avoids a re-render
        // per focus change); the pane exposes it so bare-key shortcuts don't fire mid-typing.
        { ...ctx, composerFocused: activeThreadRef.current?.isComposerFocused() ?? false },
        pendingG.current,
      )
      // A pending `g` is consumed by whatever key came next (matched or not); re-arm only on g-prefix.
      const wasPendingG = pendingG.current
      if (wasPendingG) clearPendingG()
      if (!intent) return

      switch (intent.type) {
        case "palette":
          e.preventDefault()
          setPaletteOpen(true)
          break
        case "overlay":
          e.preventDefault()
          setOverlayOpen(true)
          break
        case "g-prefix":
          e.preventDefault()
          pendingG.current = true
          gTimer.current = setTimeout(() => {
            pendingG.current = false
          }, G_SEQUENCE_MS)
          break
        case "go-inbox":
          e.preventDefault()
          backToList()
          break
        case "focus-next":
          e.preventDefault()
          if (view === "list") moveListFocus(1)
          else activeThreadRef.current?.focusNext()
          break
        case "focus-prev":
          e.preventDefault()
          if (view === "list") moveListFocus(-1)
          else activeThreadRef.current?.focusPrev()
          break
        case "open": {
          e.preventDefault()
          const c = conversations.find((x) => x.id === focusedConvId)
          if (c) openConversation(c)
          break
        }
        case "edit":
          e.preventDefault()
          activeThreadRef.current?.command("edit")
          break
        case "delete":
          e.preventDefault()
          activeThreadRef.current?.command("delete")
          break
        case "react":
          e.preventDefault()
          activeThreadRef.current?.command("react")
          break
        case "toggle-read":
          e.preventDefault()
          toggleReadUnread(ctx.focusedConversationId ?? null)
          break
        case "focus-composer":
          e.preventDefault()
          activeThreadRef.current?.focusComposer()
          break
        case "settings":
          e.preventDefault()
          setSettingsOpen((v) => !v)
          break
        case "conv-next":
          e.preventDefault()
          switchConversation(1)
          break
        case "conv-prev":
          e.preventDefault()
          switchConversation(-1)
          break
        case "conv-index":
          e.preventDefault()
          openConvByIndex(intent.index)
          break
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [
    ctx,
    view,
    paletteOpen,
    overlayOpen,
    conversations,
    focusedConvId,
    moveListFocus,
    openConversation,
    backToList,
    clearPendingG,
    toggleReadUnread,
    switchConversation,
    openConvByIndex,
  ])

  // In the Electron shell (window.chatShell present), flag the root so the CSS can turn the top
  // headers into a window-drag region + clear the macOS traffic lights (chat/src/index.css).
  useEffect(() => {
    if (chatShell()) document.documentElement.classList.add("is-electron")
  }, [])

  // Report the current SPA path to the Electron shell so the next launch reopens this conversation.
  useEffect(() => {
    chatShell()?.routeChanged(keepAlive.active ? pathFor(keepAlive.active) : "/chat/")
  }, [keepAlive.active])

  // "Reconnecting…" banner: the background list poll flips this on failure and back on success.
  const [online, setOnline] = useState(true)

  // Name display preference (t161), derived once per settings change and threaded to every
  // person-name render (rows, thread header, sender names, reactor tooltips).
  const namePref = useMemo<NamePref>(
    () => ({ mode: settings.nameDisplay, regex: settings.nameRegex }),
    [settings.nameDisplay, settings.nameRegex],
  )

  // Profile card (t166): one dialog at the root, opened from any row's sender header. "Message"
  // resolves an existing 1:1 by the row-avatar oid (never creates a conversation — grill Q11).
  const [profileTarget, setProfileTarget] = useState<ProfileTarget | null>(null)
  const oidTail = (id: string) => id.split(":").pop() || id
  const profileDm = profileTarget
    ? conversations.find(
        (c) =>
          c.kind === "oneOnOne" &&
          c.avatarUserId &&
          oidTail(c.avatarUserId) === oidTail(profileTarget.userId),
      )
    : undefined
  const messageFromProfile = profileDm
    ? () => {
        setProfileTarget(null)
        openConversationById(profileDm.id)
      }
    : undefined

  const threadPanes = keepAlive.mounted.map((id) => {
    const conv = convById[id]
    if (!conv) return null
    const isActive = id === keepAlive.active
    return (
      <ThreadView
        conversation={conv}
        key={id}
        namePref={namePref}
        onBack={isWide ? undefined : backToList}
        onFocusChange={isActive ? setThreadFocus : undefined}
        onOpenProfile={setProfileTarget}
        ref={isActive ? activeThreadRef : undefined}
        visible={isActive && (isWide || phoneView === "thread")}
      />
    )
  })

  const palette = (
    <>
      <CommandPalette
        actions={actions}
        ctx={ctx}
        onOpenChange={setPaletteOpen}
        open={paletteOpen}
      />
      <ShortcutOverlay actions={actions} onOpenChange={setOverlayOpen} open={overlayOpen} />
      <ProfileDialog
        onClose={() => setProfileTarget(null)}
        onMessage={messageFromProfile}
        target={profileTarget}
      />
      <PromptDialog />
      <SettingsSheet
        onOpenChange={setSettingsOpen}
        onUpdate={updateSettings}
        open={settingsOpen}
        settings={settings}
      />
      {!online && (
        <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center pt-[max(0.75rem,env(safe-area-inset-top))]">
          <div className="rounded-full bg-foreground/85 px-3 py-1 text-background text-xs shadow-md backdrop-blur">
            Reconnecting…
          </div>
        </div>
      )}
    </>
  )

  if (isWide) {
    return (
      <div className="flex h-[var(--app-h,100dvh)] w-full bg-background">
        <aside className="flex w-80 shrink-0 flex-col border-border border-r">
          <AppHeader
            canBack={canNav.back}
            canForward={canNav.forward}
            onOpenSettings={() => setSettingsOpen(true)}
          />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ConversationList
              collapsedFolders={collapsed}
              focusedId={view === "list" ? focusedConvId : null}
              folderOrder={folderOrder}
              namePref={namePref}
              onConnectionChange={setOnline}
              onConversations={onConversations}
              onOpenConversation={openConversation}
              onPatchPrefs={patchPrefs}
              onReorderFolders={setFolderOrder}
              onToggleFolder={toggleFolderCollapsed}
              prefs={prefs}
              readOverrides={readOverrides}
              selectedId={keepAlive.active || null}
            />
          </div>
        </aside>
        <section className="min-w-0 flex-1">
          {threadPanes}
          {keepAlive.mounted.length === 0 && (
            <div className="flex h-full items-center justify-center px-6 text-center text-muted-foreground text-sm">
              Select a conversation
            </div>
          )}
        </section>
        {palette}
      </div>
    )
  }

  return (
    <div className="flex h-[var(--app-h,100dvh)] w-full flex-col bg-background">
      <div className={cn("flex min-h-0 flex-1 flex-col", phoneView === "thread" && "hidden")}>
        <AppHeader
          canBack={canNav.back}
          canForward={canNav.forward}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <main className="min-h-0 flex-1 overflow-y-auto">
          <ConversationList
            collapsedFolders={collapsed}
            focusedId={focusedConvId}
            folderOrder={folderOrder}
            namePref={namePref}
            onConnectionChange={setOnline}
            onConversations={onConversations}
            onOpenConversation={openConversation}
            onPatchPrefs={patchPrefs}
            onReorderFolders={setFolderOrder}
            onToggleFolder={toggleFolderCollapsed}
            prefs={prefs}
            readOverrides={readOverrides}
            selectedId={keepAlive.active || null}
          />
        </main>
      </div>
      <div className={cn("min-h-0 flex-1", phoneView === "list" && "hidden")}>{threadPanes}</div>
      {palette}
    </div>
  )
}
