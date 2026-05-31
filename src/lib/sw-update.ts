// Service-worker update watcher for the web PWA. main.tsx registers the worker (with the
// per-build query param) and hands the registration here; app.tsx starts the watcher once
// mounted. When a new worker finishes installing while one already controls the page, it
// shows a dismissible "Update available" toast; tapping Reload skips waiting and reloads
// once. Returning to a backgrounded PWA re-checks for a new build. See t044.
//
// Belt-and-suspenders (t044): the SW path can't detect a fresh deploy on a long-lived page
// (registration.update() re-fetches the same /sw.js?v=OLD URL → identical bytes → no
// updatefound), so we *also* poll GET /api/version and compare its git sha to this bundle's
// build-time __GIT_SHA__. Either path surfaces the same reload prompt. See update-check.ts.

import { startUpdateCheck } from "./update-check"

/** How often the version poll runs while the page is alive. */
const VERSION_POLL_MS = 15 * 60 * 1000

let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null

/** Called by main.tsx right after navigator.serviceWorker.register (web build only). */
export function setSwRegistration(p: Promise<ServiceWorkerRegistration | null>): void {
  registrationPromise = p
}

type ShowUpdateToast = (onReload: () => void) => void

function postSkipWaiting(worker: ServiceWorker | null): void {
  worker?.postMessage({ type: "SKIP_WAITING" })
}

// Tells the page a new worker is installed and ready to take over. Fires on a fresh
// `updatefound` that reaches `installed` *and* whenever a worker is already waiting at
// start (the update can land before the watcher attaches).
function onWaitingWorker(reg: ServiceWorkerRegistration, show: ShowUpdateToast): void {
  const reload = () => postSkipWaiting(reg.waiting)
  if (reg.waiting && navigator.serviceWorker.controller) show(reload)

  reg.addEventListener("updatefound", () => {
    const installing = reg.installing
    if (!installing) return
    installing.addEventListener("statechange", () => {
      // `controller` exists only after the first activation — its absence means this is
      // the first install, which must stay silent (no toast on a fresh PWA).
      if (installing.state === "installed" && navigator.serviceWorker.controller) {
        show(() => postSkipWaiting(reg.waiting))
      }
    })
  })
}

/**
 * Idempotent — safe under StrictMode double-invoke. Returns a cleanup that detaches the
 * visibilitychange listener (the SW listeners live for the page's lifetime by design).
 */
export function startUpdateWatcher(show: ShowUpdateToast): () => void {
  if (!registrationPromise) return () => {}

  let reloading = false
  const reloadNow = () => {
    if (reloading) return
    reloading = true
    window.location.reload()
  }
  const onControllerChange = () => reloadNow()
  navigator.serviceWorker.addEventListener("controllerchange", onControllerChange)

  let reg: ServiceWorkerRegistration | null = null
  registrationPromise.then((r) => {
    reg = r
    if (r) onWaitingWorker(r, show)
  })

  // Version poll (t044) — only meaningful with a real build sha (skip in dev). A newer
  // deploy has no waiting SW to skip, so the prompt's reload is a plain hard reload.
  const versionCheck =
    __GIT_SHA__ && __GIT_SHA__ !== "unknown"
      ? startUpdateCheck({
          currentSha: __GIT_SHA__,
          fetchServerVersion: () => fetch("/api/version").then((r) => r.json()),
          onUpdate: () => show(reloadNow),
          intervalMs: VERSION_POLL_MS,
        })
      : null

  const onVisible = () => {
    if (document.visibilityState !== "visible") return
    reg?.update().catch(() => {})
    versionCheck?.check()
  }
  document.addEventListener("visibilitychange", onVisible)
  const onFocus = () => versionCheck?.check()
  window.addEventListener("focus", onFocus)

  return () => {
    document.removeEventListener("visibilitychange", onVisible)
    window.removeEventListener("focus", onFocus)
    versionCheck?.stop()
  }
}
