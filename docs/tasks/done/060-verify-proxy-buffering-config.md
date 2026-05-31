# 060 — document + surface the minimal proxy buffering config for fast input

- **Status:** done
- **Mode:** HITL
- **Ring:** outer
- **Slice:** 4-table-stakes-latency
- **Estimate:** 0.5d
- **Depends on:** none
- **Blocks:** none

## Goal

A web build deployed behind a buffering reverse proxy (the default nginx/Authentik
setup) silently runs the slow input path: the streaming input channel can't activate
without `proxy_request_buffering off`, and the WS transport silently falls back to
SSE+POST without the three WS upgrade headers. The operator gets sluggish input and
no signal as to why. After this task, the **minimal upstream proxy config is written
down** in a guide an operator can copy verbatim, and the **status bar surfaces when the
fast path failed to activate** (streaming/WS fell back) so the operator knows there is
a proxy to fix rather than assuming the app is just slow.

## Why now

The web PWA is the v0.1.0 release surface and the daily driver behind a real proxy
(Authentik at the portal). The latency cheap-wins in this slice (t054–t057) are
wasted if the operator is stuck on the buffered fallback and never knows it. This is
the cheap, docs-heavy capstone of the latency slice: it turns an invisible
mis-configuration into a visible, copy-paste-fixable one. **Outer ring** — not
tag-blocking for v0.1.0, a v0.1.1 fast-follow.

## Acceptance criteria

- [ ] `docs/guides/proxy-buffering-config.md` exists and documents the **minimal**
      upstream proxy config for the fast input path: `proxy_request_buffering off` for
      the streaming input channel, and the three WS upgrade lines
      (`proxy_http_version 1.1`, `proxy_set_header Upgrade $http_upgrade`,
      `proxy_set_header Connection $http_connection`) for the WS transport.
- [ ] The guide states the **observable symptom** of each missing setting (streaming
      never confirms → falls back to `/api/cdp-batch`; WS never opens → falls back to
      SSE+POST) and points at the in-app indicator added here.
- [ ] The guide is copy-paste-ready: a complete nginx `location` block (or Nginx Proxy
      Manager "custom config" snippet) the operator can drop in, matching the deployed
      setup referenced in the existing memories/ADRs.
- [ ] The status bar shows a **non-blocking indicator** when the active input transport
      is NOT the fastest available — i.e. streaming/WS was attempted and degraded to the
      POST/SSE fallback — and shows **nothing** when the fast path is active (no clutter
      in the happy case).
- [ ] The indicator links to (or names) the guide so the operator knows the fix is a
      proxy change, not an app bug.
- [ ] The indicator reads its state from the existing transport signal (the
      `transport-selector.ts` degraded/active-mode state surfaced for t059's HUD); it
      introduces no new probing or polling of its own.
- [ ] `pnpm check` (touched files) / `pnpm typecheck` / `pnpm test` green.

## Test plan

### Layer 1 — Pure logic (TDD)

n/a — docs + a presentational indicator. The fallback-vs-fast decision already lives
in `transport-selector.ts` (pure, covered by `transport-selector.test.ts` from t019);
this task only **reads** `isDegraded()` / `getActiveMode()` and renders. No new pure
logic. If the read needs a tiny pure mapper (active mode → "fast" | "fallback" label),
add it as a one-line helper with a unit test; otherwise inline it.

### Layer 2 — Manual smoke (CDP/IPC)

Needs a live Remote Browser **and** a buffering proxy in front of `web/server.mjs`
(HITL — requires the deployed/portal setup or a local nginx without
`proxy_request_buffering off`):

- [ ] With a buffering proxy (no `proxy_request_buffering off`, no WS headers): load
      the web build, move/click in the viewport → the status bar shows the
      fallback indicator naming the proxy config.
- [ ] Apply the guide's config (streaming + WS headers) and reload → the fast path
      activates and the indicator disappears.
- [ ] On a direct connection (no proxy, e.g. Tailscale Serve to local `:7800` per the
      `cloud01` / `m4-pro-mbp` setups) the fast path is active and the indicator is
      hidden from the first frame.

### Layer 3 — Visual review

- [ ] Screenshot of the status bar in the **fallback** state (indicator visible) and
      the **fast-path** state (indicator hidden) via Chrome DevTools against `pnpm web`.
      The fallback state can be forced by pinning the transport to `batch` in settings
      (manual mode) rather than standing up a real proxy.
- [ ] Indicator does not push/jitter the existing loading/error status-bar content; it
      sits as its own slim segment and respects the safe-area bottom inset already on
      the status bar.

## Design notes

This is mostly documentation plus one small surfaced indicator. It reuses the transport
signal that t057/t059 expose; it does not add a new transport mechanism or probe.

- **`docs/guides/proxy-buffering-config.md`** (new): the operator-facing guide. Sits
  alongside the existing `docs/guides/` how-tos. Documents the two settings, their
  symptoms, and a copy-paste nginx/NPM block. Cross-links ADR-0006 (web proxy SSE/POST
  transport — where the streaming fallback + `proxy_request_buffering off` requirement
  originate) and ADR-0007 (WS transport — where the three WS upgrade headers and the
  silent-fallback behaviour are documented). References done-task t011/t013 for the
  streaming-input-channel + POST-fallback backpressure context.

- **`src/components/status-bar.tsx`** (edit): add a slim, non-blocking segment that
  renders only when the input transport is on the fallback path. It receives the
  fallback state as a prop (the transport's degraded/active-mode signal, owned by the
  web transport in `cdp-web-transport.ts` and surfaced through `app.tsx`, same source
  t059's HUD consumes) — the component stays presentational and reads no transport
  internals itself. Hidden when the fast path is active so the happy case has zero
  extra chrome. The segment names the guide (a short "input on fallback — check proxy"
  affordance) rather than dumping config inline.

- **Contracts changed:** `StatusBarProps` gains an optional fallback-state field
  (e.g. `inputFallback?: { mode: InputTransportMode }` or a simpler boolean +
  reason). Additive and optional — Electron and the fast-path web case pass nothing
  and render unchanged.
- **New modules:** none (unless a trivial active-mode → label mapper is warranted; see
  Layer 1).
- **New ADR needed?** no — this surfaces and documents behaviour already decided in
  ADR-0006 and ADR-0007; no new architectural decision.

```ts
// additive, in status-bar.tsx props — optional so existing callers are unchanged
interface StatusBarProps {
  loading: boolean
  loadingText: string
  onOpenSettings?: () => void
  inputFallback?: { mode: InputTransportMode } | null // null/undefined = fast path, render nothing
}
```

## Out of scope

- **Latency HUD (t059)** — the toggleable RTT/jitter/transport HUD is its own task; this
  task only adds the single fallback indicator, not the full metrics overlay.
- **The RTT/jitter metrics pipeline (t057)** — this task consumes the existing transport
  mode/degraded signal only; it does not add or change metrics collection.
- **Auto-fixing or auto-detecting the proxy config server-side** — the proxy is
  operator-owned; we document and surface, we don't reconfigure it.
- **Changing the streaming/WS fallback logic itself** — the fallback mechanics
  (t011/t013/t019) are unchanged; only their outcome is made visible.
- **Electron** — the indicator is web-only (Electron has no proxy hop); it is inert
  under Electron, which never passes the prop.

## Definition of Done

- [ ] Layer 1 tests written and green (if the trivial label mapper was added; otherwise
      n/a, noted).
- [ ] Layer 2 smoke checklist completed with a live Remote Browser behind a buffering
      proxy (HITL).
- [ ] Layer 3 screenshots captured and committed (fallback + fast-path states).
- [ ] `pnpm check` clean (Biome — lint + format, touched files).
- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test` green.
- [ ] `pnpm web` boots cleanly and the indicator renders correctly in both states.
- [ ] CLAUDE.md updated if the `StatusBarProps` surface or status-bar behaviour changed.
- [ ] No commented-out code, no `console.log` debris, no AI attribution.
- [ ] Task closed: status → done, file moved to `docs/tasks/done/`, t060 in commit.

## Notes

The fallback path is the **designed-for safe state** (t013) — input still works, just
slower. The whole point of this task is honesty: the operator deserves to know they're
on the safe state so they can choose to fix the proxy and unlock the fast path, instead
of silently tolerating lag. Keep the indicator quiet (one slim segment, hidden when
fast) so it never becomes noise; the loud part is the guide.
