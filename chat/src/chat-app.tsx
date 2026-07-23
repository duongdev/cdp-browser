import { BubbleChatIcon, Settings02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { CommandPalette } from "./components/command-palette"
import { ConversationList } from "./components/conversation-list"
import { SettingsSheet } from "./components/settings-sheet"
import { ShortcutOverlay } from "./components/shortcut-overlay"
import { type ThreadFocus, type ThreadHandle, ThreadView } from "./components/thread-view"
import { routeKey } from "./lib/chat-keys"
import { parsePath, pathFor } from "./lib/chat-route"
import { buildActions, type ChatAction, type ChatContext } from "./lib/command-registry"
import {
  isUnread,
  knownFolders,
  navigableConversations,
  type ReadOverride,
} from "./lib/conversation-view"
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

function AppHeader({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <header className="flex items-center gap-2 border-border border-b px-4 py-3">
      <HugeiconsIcon className="size-5 text-primary" icon={BubbleChatIcon} />
      <h1 className="font-heading font-semibold text-base text-foreground">Teams Chat</h1>
      <Button
        aria-label="Settings"
        className="ml-auto text-muted-foreground"
        onClick={onOpenSettings}
        size="icon-sm"
        variant="ghost"
      >
        <HugeiconsIcon className="size-4" icon={Settings02Icon} />
      </Button>
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
  const onConversations = useCallback((list: TeamsConversation[]) => {
    conversationsRef.current = list
    setConversations(list)
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
      const path = pathFor(conv.id)
      if (window.location.pathname !== path) window.history.pushState(null, "", path)
    },
    [patchConvRead],
  )

  const openConversationById = useCallback(
    (id: string, push = true) => {
      setConvById((m) => (m[id] ? m : { ...m, [id]: stubConversation(id) }))
      setKeepAlive((s) => openThread(s, id))
      setPhoneView("thread")
      patchConvRead(id, "read", true)
      const path = pathFor(id)
      if (push && window.location.pathname !== path) window.history.pushState(null, "", path)
    },
    [patchConvRead],
  )

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
    const onPop = () => {
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
    if (window.location.pathname !== "/chat/") window.history.pushState(null, "", "/chat/")
  }, [])

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
  // Local conversation prefs (t156): labels/folder/mute (shared server-side) + per-device folder
  // collapse state. Applied over the list rows inside ConversationList (poll-proof, like read overrides).
  const { prefs, patch: patchPrefs, collapsed, toggleFolderCollapsed } = useConvPrefs()
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
    const jumps: ChatAction[] = conversations.slice(0, 50).map((c) => ({
      id: `jump:${c.id}`,
      label: c.title?.trim() || c.topic?.trim() || (c.kind === "self" ? "Notes" : "Direct message"),
      group: "Conversation",
      run: () => openConversation(c),
    }))
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
        id: "open-settings",
        label: "Open settings",
        group: "App",
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
        label: prefs[ctx.focusedConversationId ?? ""]?.muted
          ? "Unmute conversation"
          : "Mute conversation",
        group: "Conversation",
        when: (c) => !!c.focusedConversationId,
        run: () => {
          const id = ctx.focusedConversationId
          if (id) patchPrefs(id, { muted: !prefs[id]?.muted })
        },
      },
      // Move to folder (t156). Palette-simple: prompt for a folder name (blank clears). The row menu
      // has the full submenu of existing folders; this is the keyboard-driven quick path.
      {
        id: "move-folder",
        label: "Move to folder…",
        group: "Conversation",
        when: (c) => !!c.focusedConversationId,
        run: () => {
          const id = ctx.focusedConversationId
          if (!id) return
          const existing = knownFolders(prefs)
          const hint = existing.length ? ` (${existing.join(", ")})` : ""
          const name = window.prompt(
            `Move to folder${hint} — blank to remove`,
            prefs[id]?.folder ?? "",
          )
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
  ])

  const threadPanes = keepAlive.mounted.map((id) => {
    const conv = convById[id]
    if (!conv) return null
    const isActive = id === keepAlive.active
    return (
      <ThreadView
        conversation={conv}
        key={id}
        onBack={isWide ? undefined : backToList}
        onFocusChange={isActive ? setThreadFocus : undefined}
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
      <SettingsSheet
        onOpenChange={setSettingsOpen}
        onUpdate={updateSettings}
        open={settingsOpen}
        settings={settings}
      />
    </>
  )

  if (isWide) {
    return (
      <div className="flex h-[var(--app-h,100dvh)] w-full bg-background">
        <aside className="flex w-80 shrink-0 flex-col border-border border-r">
          <AppHeader onOpenSettings={() => setSettingsOpen(true)} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ConversationList
              collapsedFolders={collapsed}
              focusedId={view === "list" ? focusedConvId : null}
              onConversations={onConversations}
              onOpenConversation={openConversation}
              onPatchPrefs={patchPrefs}
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
        <AppHeader onOpenSettings={() => setSettingsOpen(true)} />
        <main className="min-h-0 flex-1 overflow-y-auto">
          <ConversationList
            collapsedFolders={collapsed}
            focusedId={focusedConvId}
            onConversations={onConversations}
            onOpenConversation={openConversation}
            onPatchPrefs={patchPrefs}
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
