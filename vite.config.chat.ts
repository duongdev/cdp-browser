import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import pkg from "./package.json"

// Second Vite entry for the standalone Teams chat app (t128, ADR-0019). Root is `chat/`,
// served at the same-origin path `/chat` (hence `base: "/chat/"` so assets + deep links
// resolve absolutely). The `@` alias points at the browser renderer's `src/` so the chat app
// reuses the shared shadcn design system instead of forking it. The main `/` build
// (vite.config.ts → dist/) is untouched — this config never runs during `vite build`.
export default defineConfig({
  root: "chat",
  base: "/chat/",
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_SHA__: JSON.stringify("chat"),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist-chat"),
    emptyOutDir: true,
  },
})
