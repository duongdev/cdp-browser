const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("cdp", {
  listTabs: () => ipcRenderer.invoke("cdp:list-tabs"),
  newTab: (url) => ipcRenderer.invoke("cdp:new-tab", url),
  closeTab: (id) => ipcRenderer.invoke("cdp:close-tab", id),
  connect: (id) => ipcRenderer.invoke("cdp:connect", id),
  send: (method, params) => ipcRenderer.send("cdp:send", method, params),
  invoke: (method, params) => ipcRenderer.invoke("cdp:invoke", method, params),
  onEvent: (cb) => ipcRenderer.on("cdp:event", (_, msg) => cb(msg)),
  onDisconnected: (cb) => ipcRenderer.on("cdp:disconnected", () => cb()),
  getConfig: () => ipcRenderer.invoke("cdp:config"),
  setConfig: (config) => ipcRenderer.invoke("cdp:set-config", config),
  testConfig: (config) => ipcRenderer.invoke("cdp:test-config", config),
  getSidebarWidth: () => ipcRenderer.invoke("cdp:get-sidebar-width"),
  setSidebarWidth: (width) => ipcRenderer.invoke("cdp:set-sidebar-width", width),
  getUiState: () => ipcRenderer.invoke("cdp:get-ui-state"),
  setUiState: (partial) => ipcRenderer.invoke("cdp:set-ui-state", partial),
  setThemeSource: (source) => ipcRenderer.invoke("cdp:set-theme-source", source),
  getThemeSource: () => ipcRenderer.invoke("cdp:get-theme-source"),
  onNativeThemeChanged: (cb) =>
    ipcRenderer.on("cdp:native-theme-changed", (_, isDark) => cb(isDark)),
  copyToClipboard: (text) => ipcRenderer.invoke("cdp:copy-to-clipboard", text),
  readClipboard: () => ipcRenderer.invoke("cdp:read-clipboard"),
  readClipboardImage: () => ipcRenderer.invoke("cdp:read-clipboard-image"),
  readClipboardFiles: () => ipcRenderer.invoke("cdp:read-clipboard-files"),
  onSwipe: (cb) => ipcRenderer.on("cdp:swipe", (_, direction) => cb(direction)),
  // Pins
  getPins: () => ipcRenderer.invoke("cdp:get-pins"),
  addPin: (pin) => ipcRenderer.invoke("cdp:add-pin", pin),
  updatePin: (id, patch) => ipcRenderer.invoke("cdp:update-pin", id, patch),
  removePin: (id) => ipcRenderer.invoke("cdp:remove-pin", id),
  reorderPins: (pins) => ipcRenderer.invoke("cdp:reorder-pins", pins),
  // Notifications
  getNotifications: () => ipcRenderer.invoke("cdp:get-notifications"),
  markNotificationRead: (id) => ipcRenderer.invoke("cdp:mark-notification-read", id),
  markNotificationUnread: (id) => ipcRenderer.invoke("cdp:mark-notification-unread", id),
  markNotificationsRead: () => ipcRenderer.invoke("cdp:mark-notifications-read"),
  clearNotifications: () => ipcRenderer.invoke("cdp:clear-notifications"),
  onNotification: (cb) => ipcRenderer.on("cdp:notification", (_, entry) => cb(entry)),
  onNotificationActivate: (cb) =>
    ipcRenderer.on("cdp:notification-activate", (_, entry) => cb(entry)),
})

// Local tabs render as <webview> in the renderer; main owns only the session,
// permissions, extensions, pins persistence, and the action-popup popover.
contextBridge.exposeInMainWorld("local", {
  getPins: () => ipcRenderer.invoke("local:get-pins"),
  savePins: (pins) => ipcRenderer.invoke("local:save-pins", pins),
  getExtensions: () => ipcRenderer.invoke("local:get-extensions"),
  pickExtension: () => ipcRenderer.invoke("local:pick-extension"),
  reloadExtension: (p) => ipcRenderer.invoke("local:reload-extension", p),
  removeExtension: (p) => ipcRenderer.invoke("local:remove-extension", p),
  openActionPopup: (id, anchor) => ipcRenderer.invoke("local:open-action-popup", { id, anchor }),
  closeActionPopup: () => ipcRenderer.invoke("local:close-action-popup"),
})
