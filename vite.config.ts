import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import path from "path"
import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  build: {
    outDir: "dist",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Don't run tests from agent worktrees checked out under .claude/, and
  // exclude the spawned-server E2E specs (run via `pnpm test:e2e` instead).
  test: {
    exclude: [...configDefaults.exclude, "**/.claude/**", "test/e2e/**"],
  },
})
