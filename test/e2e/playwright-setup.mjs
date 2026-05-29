// Playwright global setup: start the fake CDP host + web server before tests,
// tear them down in global teardown. Ports are stashed on process.env so the
// Playwright config can wire them into the webServer.baseURL and so the tests
// can find the fake host.

import { startFakeCdpHost, DEFAULT_TARGETS } from "./fake-cdp-host.mjs"
import { startWebServer } from "./server-harness.mjs"

// Store cleanup functions on global for teardown.
let fakeCdpHost
let webServer

export default async function globalSetup() {
  fakeCdpHost = await startFakeCdpHost({
    targets: DEFAULT_TARGETS,
    frameCadenceMs: 150,
  })
  process.env.FAKE_CDP_PORT = String(fakeCdpHost.port)
  process.env.FAKE_CDP_HOST = fakeCdpHost.host

  webServer = await startWebServer(fakeCdpHost)
  process.env.WEB_SERVER_PORT = String(webServer.port)
  process.env.WEB_SERVER_BASE = webServer.base

  // Expose cleanup on globalThis so teardown.mjs can access it.
  globalThis.__e2eFakeCdpHost = fakeCdpHost
  globalThis.__e2eWebServer = webServer
}
