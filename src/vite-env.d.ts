/// <reference types="vite/client" />

interface Bookmark {
  id: string;
  title: string;
  url: string;
  favicon?: string;
}

interface CdpBridge {
  listTabs: () => Promise<any>;
  newTab: (url?: string) => Promise<any>;
  closeTab: (id: string) => Promise<any>;
  connect: (id: string) => Promise<any>;
  send: (method: string, params?: any) => void;
  invoke: (method: string, params?: any) => Promise<any>;
  onEvent: (cb: (msg: any) => void) => void;
  onDisconnected: (cb: () => void) => void;
  getConfig: () => Promise<{ host: string; port: number }>;
  setConfig: (config: { host: string; port: number }) => Promise<void>;
  setThemeSource: (source: "system" | "light" | "dark") => Promise<void>;
  getThemeSource: () => Promise<"system" | "light" | "dark">;
  onNativeThemeChanged: (cb: (isDark: boolean) => void) => void;
  // Bookmarks
  getBookmarks: () => Promise<Bookmark[]>;
  addBookmark: (bookmark: Bookmark) => Promise<Bookmark[]>;
  removeBookmark: (url: string) => Promise<Bookmark[]>;
  reorderBookmarks: (bookmarks: Bookmark[]) => Promise<Bookmark[]>;
}

interface Window {
  cdp: CdpBridge;
}
