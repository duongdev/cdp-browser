// Preload for the standalone "CDP Chats" Electron shell. Exposes a tiny bridge so
// the chat renderer (loaded from the web server) drives native OS notifications +
// the dock badge through the main process — the same mechanism as the CDP Browser
// app, instead of the web Notification / Web-Push path (which is unreliable in
// Electron). Mirrors the `window.chatShell` contract in chat/src/lib/chat-shell.ts.
const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("chatShell", {
  notify: (payload) => ipcRenderer.send("chat:notify", payload),
  setBadge: (count) => ipcRenderer.send("chat:set-badge", count),
  onNotificationActivate: (cb) =>
    ipcRenderer.on("chat:notification-activate", (_e, convId) => cb(convId)),
  goBack: () => ipcRenderer.send("chat:go-back"),
  goForward: () => ipcRenderer.send("chat:go-forward"),
  reload: () => ipcRenderer.send("chat:reload"),
  getServerUrl: () => ipcRenderer.invoke("chat:get-server-url"),
  setServerUrl: (url) => ipcRenderer.send("chat:set-server-url", url),
  routeChanged: (path) => ipcRenderer.send("chat:route", path),
})
