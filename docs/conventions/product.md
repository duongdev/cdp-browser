# Product mindset

CDP Browser is software, but the bar is **product quality**. Every decision is graded against "does this make the app feel like something I'd want to use as my daily browser?" — not against "is this technically correct?"

## The product principle

**Product, not software.** Software is correct, fast, and modular. A daily-driver app is *useful, fast-feeling, and invisible as infrastructure*. When the app is working perfectly, the user is thinking about the Remote Browser's content — not about CDP connections, screencast frames, or Electron IPC.

A daily-driver browser lives or dies on the *never-stuck* experience. The user must never reach a state where their only recourse is to quit and reopen. Auto-reconnect, soft-reload, retryable actions, graceful degradation — these are the product, not optional polish.

---

## What "product, not software" means in practice

### Decisions are framed by user impact

When weighing options, ask:

- **Who feels this?** The user while browsing, only during setup, only on failure?
- **When?** Every tab switch, occasionally, only on errors?
- **What's the cost of getting it wrong?** Stuck screen, wrong coordinates, lost tab, broken paste?

A 10% throughput improvement in screencast frame processing that nobody perceives is software work. A one-frame reduction in the jitter when switching tabs — visible on every tab switch — is product work. Pick the second when forced to.

### "Almost works" doesn't ship

An app that "works on the happy path" is not a product. The edge cases — the page that triggers an unusual CDP event, the Remote Browser that restarts mid-session, the window resize that breaks Adaptive Viewport — are where products are made or broken. Tasks must have the edge cases handled, not just listed.

### UI quality is product quality

A jittery interface, a mistimed loading state, or a toolbar that reflows on every navigation destroys trust faster than any backend bug. **Pixel-perfect, no jiggling, design-system-consistent.** See [ux.md](ux.md) and [frontend.md](frontend.md).

### The screencast experience is the product

Every user action passes through Input Forwarding → CDP → Remote Browser → Screencast Frame → canvas. Any friction in this chain — coordinate offset, frame drop, slate screen on tab switch — is a product failure, not a minor bug. Invest in this loop disproportionately.

---

## The never-stuck bar

This is the CDP-Browser-specific analogue of Lure's "invisibility" rule. It is the product's reliability contract:

**The user must never be stuck in the app.** Every failure has a recovery path. Every stuck state has an escape hatch.

### What this rules out

- **"Connecting…" that hangs indefinitely** without a retry button or a timeout that surfaces the real error.
- **Blank canvas after tab switch** without a "reconnecting…" indicator and auto-retry.
- **Settings that can only be fixed by deleting `userData`** — every setting must be editable in the drawer.
- **IPC failures that silently drop** — the renderer must surface every error the main process returns.
- **Missing Cmd+R escape hatch** — if the user genuinely needs to hard-reload, that must work. But first, build the soft-reload path.

### What this requires

- **Auto-reconnect with exponential backoff.** When the WebSocket drops, retry silently at first, then surface a "Reconnecting…" pill after the first failure. Never a blank screen.
- **Manual reconnect always available.** Settings drawer has a "Reconnect" button. Status bar shows connection state.
- **Soft-reload path for stuck states.** Re-fetch tab list, re-establish screencast, restore last URL — without losing in-memory UI state.
- **Graceful degradation.** If Adaptive Viewport fails to apply, fall back to letterbox silently. Never block the screencast on an optional feature.
- **Settings crash-safe.** `loadSettings()` in `main.js` catches parse errors and returns defaults. A malformed `settings.json` must not prevent the app from starting.

---

## Product-quality checklist (for every feature)

Before shipping any user-visible change, ask:

- [ ] Does this make the daily browsing workflow noticeably better or at least not worse?
- [ ] Is the worst-case path (connection drop, Remote Browser restart, resize during Adaptive Viewport) acceptable?
- [ ] Does it look pixel-perfect at 1440×900 and 1920×1080?
- [ ] Loading, empty, error, and not-found states — designed, not afterthought?
- [ ] Keyboard parity — every new action has a shortcut (see [ux.md](ux.md))?
- [ ] The user can recover from any failure without quitting the app?
- [ ] Would you be comfortable using this as your primary browser window for a full day?

The bar isn't "passes review." The bar is "I'd want to use this."

---

## Scope of the product

CDP Browser is a desktop Electron app wrapping a Remote Browser. It is not:

- A general-purpose web browser (no downloads, no file system access, no extensions).
- A mobile app (no mobile targets, no touch-first UX).
- A multi-window app (one window, one Remote Browser connection at a time).

Scope creep toward any of these is a design decision, not a task. Open an ADR.

---

_Software is the means. A native-feeling, never-stuck browser is the point._

_Last revisited: 2026-05-23_
