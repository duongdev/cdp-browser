// Separate Vitest config for E2E specs: spawned-server tests that are too slow
// for the fast unit run. Run via `pnpm test:e2e`. See test/e2e/README.md.
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.test.ts"],
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 15000,
    // Run serially — each spec boots a real server child process.
    pool: "forks",
    singleFork: true,
  },
})
