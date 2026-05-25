// Preload for extension action-popup views. Electron has no chrome.storage.sync;
// alias it to chrome.storage.local at document-start so extensions that read
// sync (and would otherwise throw, leaving popup toggles blank) work. Runs in
// the page's main world (the popup view is created with contextIsolation:false).
;(() => {
  function patch() {
    try {
      const s = window.chrome?.storage
      if (s?.local) {
        Object.defineProperty(s, "sync", { value: s.local, configurable: true, writable: true })
        return true
      }
    } catch (_) {}
    return false
  }
  if (!patch()) {
    const iv = setInterval(() => {
      if (patch()) clearInterval(iv)
    }, 0)
    setTimeout(() => clearInterval(iv), 3000)
  }
})()
