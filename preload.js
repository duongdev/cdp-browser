const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('cdp', {
  listTabs: () => ipcRenderer.invoke('cdp:list-tabs'),
  newTab: (url) => ipcRenderer.invoke('cdp:new-tab', url),
  closeTab: (id) => ipcRenderer.invoke('cdp:close-tab', id),
  connect: (id) => ipcRenderer.invoke('cdp:connect', id),
  send: (method, params) => ipcRenderer.send('cdp:send', method, params),
  invoke: (method, params) => ipcRenderer.invoke('cdp:invoke', method, params),
  onEvent: (cb) => ipcRenderer.on('cdp:event', (_, msg) => cb(msg)),
  onDisconnected: (cb) => ipcRenderer.on('cdp:disconnected', () => cb()),
  getConfig: () => ipcRenderer.invoke('cdp:config'),
  setConfig: (config) => ipcRenderer.invoke('cdp:set-config', config),
  setThemeSource: (source) => ipcRenderer.invoke('cdp:set-theme-source', source),
  getThemeSource: () => ipcRenderer.invoke('cdp:get-theme-source'),
  onNativeThemeChanged: (cb) => ipcRenderer.on('cdp:native-theme-changed', (_, isDark) => cb(isDark)),
  // Bookmarks
  getBookmarks: () => ipcRenderer.invoke('cdp:get-bookmarks'),
  addBookmark: (bookmark) => ipcRenderer.invoke('cdp:add-bookmark', bookmark),
  removeBookmark: (url) => ipcRenderer.invoke('cdp:remove-bookmark', url),
  reorderBookmarks: (bookmarks) => ipcRenderer.invoke('cdp:reorder-bookmarks', bookmarks),
})
