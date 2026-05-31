import { execSync } from "node:child_process"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import path from "path"
import { configDefaults, defineConfig } from "vitest/config"
import pkg from "./package.json"

// Short git SHA at build time; "unknown" outside a checkout (e.g. a .git-less Docker context).
const gitSha = (() => {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim()
  } catch {
    return "unknown"
  }
})()

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  // Compile-time build identity; declared in src/vite-env.d.ts. Vite define is textual
  // replacement, so values must be valid source literals (hence JSON.stringify).
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_SHA__: JSON.stringify(gitSha),
  },
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
