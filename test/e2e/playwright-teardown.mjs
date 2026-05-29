// Playwright global teardown: stop the fake host + web server.
export default async function globalTeardown() {
  const host = globalThis.__e2eFakeCdpHost
  const server = globalThis.__e2eWebServer
  if (server) server.stop()
  if (host) await host.stop()
}
