// Playwright config for the browser-layer E2E spec.
// The fake CDP host + web server are started in global setup before any test runs.
// Run via `pnpm test:e2e:browser`. See test/e2e/README.md.
import type { PlaywrightTestConfig } from "@playwright/test"

const config: PlaywrightTestConfig = {
  testDir: "test/e2e",
  testMatch: ["**/*.spec.ts"],
  globalSetup: "./test/e2e/playwright-setup.mjs",
  globalTeardown: "./test/e2e/playwright-teardown.mjs",
  timeout: 30000,
  use: {
    headless: true,
    // baseURL is resolved dynamically in global setup via process.env.WEB_SERVER_BASE,
    // but we set a placeholder here; tests read process.env.WEB_SERVER_BASE directly.
    baseURL: "http://127.0.0.1:7800",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  reporter: [["list"], ["json", { outputFile: "test/e2e/playwright-results.json" }]],
}

export default config
