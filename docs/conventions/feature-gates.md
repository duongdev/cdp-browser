# Feature gates: gate at the data source, not just at render

Some features are **Electron-only** — they need native capabilities the web build can't have (local `<webview>` tabs need a real Electron session; unpacked MV3 extensions need a real Chromium). The web build runs the *same* renderer, so it must hide **and** disable those features without forking the component tree.

The rule: **gate at the data source via capabilities, not only at the render boundary.** A consumer that's gated only at render still imports, runs, and wires the Electron-only logic — it just hides the result. On web, that logic runs against a no-op stub and quietly misbehaves. Gating at the source means the consumer *physically cannot reach* the gated logic when the capability is absent.

## How it works

1. **One capability object.** `window.webCaps` (set by the web shim, absent under Electron) is the single source of truth for "what can this build do." Read it through one accessor — `getCaps()` in [src/lib/caps.ts](../../src/lib/caps.ts) (re-exported by `cdp-web-transport.ts` for back-compat) — never `window.webCaps` inline. Under Electron the accessor returns the full-capability default; on web it returns the restricted set.

2. **A guarded hook owns the gated source.** Each Electron-only feature gets a hook that returns **empty state + no-op handlers** when its capability is off:

   ```ts
   function useLocalTabs(): LocalTabsApi {
     const caps = getCaps()
     if (!caps.localTabs) return EMPTY_LOCAL_TABS  // frozen empty list + no-op handlers
     // …real wiring: window.local.*, persistence, event subscriptions
   }
   ```

   Consumers (`app.tsx`) call the hook and drive whatever it returns. When the capability is off, the hook hands back nothing to drive — so `app.tsx` *cannot* call `window.local.*` on web even by accident. The gate lives **once**, at the source, instead of being re-checked at every call site.

3. **Render gates follow for free.** UI affordances (sidebar section, settings panel) still wrap in `caps.localTabs && …` so the section disappears. That's the **hide** half. The hook is the **disable** half. Both read the same `caps` — they never drift.

So every seam — data load, persistence, event wiring, handlers, render — reads **one** gated source. Hide *and* disable, from one switch.

## Worked example: local tabs (the bug this prevents)

Local tabs touch the renderer in ~6 seams: initial pin/tab load, extension list load, extension pick/reload/remove, action-popup open, and persistence on change — all reaching `window.local.*` from `app.tsx`. Plus two render seams (the sidebar LOCAL TABS section, the settings local panel).

Before this convention, `caps.localTabs` was read in only the **2 render seams**. The other ~4 data seams ran unconditionally and leaned on the web shim's no-op `window.local` stub to not throw. That's gating at render only: the logic still executes, just against a stub — fragile (one un-stubbed method crashes the web build) and invisible (nothing says "this is Electron-only" at the call site).

The fix: a `useLocalTabs()` hook reads `caps.localTabs` **once** and returns empty/no-op when off. `app.tsx` consumes the hook instead of `window.local` directly, so on web there is no local-tab code path to run — the stub becomes a safety net, not the mechanism. See [docs/adr/0005-local-tabs-base-window.md](../adr/0005-local-tabs-base-window.md) for why local tabs are Electron-only.

## Scope (intentionally narrow)

This is **not** a generic feature-flag framework. It's a pattern applied to the two Electron-only consumers we have:

- **Local tabs** — gated via `useLocalTabs()` in [src/hooks/use-local-tabs.ts](../../src/hooks/use-local-tabs.ts) (the worked example above): the hook reads `caps.localTabs` once and returns the frozen `EMPTY_LOCAL_TABS` surface when off, so `app.tsx` never mounts `LocalWebviews`, the new-tab kind toggle is hidden, and Cmd+T / Cmd+Shift+T resolve to CDP only on web.
- **Extensions** — still gated at render only today. It adopts the same `use<Feature>()`-hook shape **when next touched** — don't pre-build the hook before there's a change that needs it (see [code-quality.md](code-quality.md) on no speculative abstraction).

If a third Electron-only consumer appears, repeat the pattern; revisit whether a shared abstraction earns its keep only once there are three real call sites.

## Checklist for a new Electron-only feature

- [ ] Add a boolean to `WebCaps` and the web shim's restricted default.
- [ ] Put the feature's data behind a `use<Feature>()` hook that returns empty state + no-op handlers when its cap is off.
- [ ] Consumers read the hook — never `window.<bridge>.*` directly.
- [ ] Wrap UI affordances in `caps.<feature> && …` so they're hidden on web.
- [ ] Confirm the web build both **hides** the affordance and runs **no** feature code path.

---

_Last revisited: 2026-05-30_
