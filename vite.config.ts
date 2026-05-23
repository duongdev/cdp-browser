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
  // Don't run tests from agent worktrees checked out under .claude/.
  test: {
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
})
