// Pure CDP HTTP (`/json`) endpoint builders. No I/O — each returns a
// `{ url, method }` request descriptor a backend can hand straight to fetch.
// Edge requires PUT for `/json/new` (Chrome tolerates it); that quirk is encoded
// here so every caller inherits it. CommonJS so both the web proxy and main.js
// can import by path. Tested by cdp-endpoints.test.ts.

const base = (host, port) => `http://${host}:${port}/json`

const list = (host, port) => ({ url: base(host, port), method: "GET" })
const newTab = (host, port, url) => ({
  url: `${base(host, port)}/new?${url || "about:blank"}`,
  method: "PUT",
})
const close = (host, port, id) => ({ url: `${base(host, port)}/close/${id}`, method: "GET" })
const activate = (host, port, id) => ({ url: `${base(host, port)}/activate/${id}`, method: "GET" })
const version = (host, port) => ({ url: `${base(host, port)}/version`, method: "GET" })

module.exports = { list, newTab, close, activate, version }
