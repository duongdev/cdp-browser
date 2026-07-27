#!/usr/bin/env node
// Manual end-to-end check for the PSN-94 GIF/sticker path (NOT a CI test — it hits live Giphy + a
// live Teams tab over CDP and writes+deletes one probe message in the self-note chat).
//
// Chain: Giphy search (real key, what the BFF `/api/chat/giphy` proxy does) → giphyEntryToItem →
// buildGifContent (both mirror chat/src/lib/teams-gif.ts) → send in-page as RichText/Html (what
// `/api/chat/reply` does with `html`) → read back → assert Teams stored it as a native AnimatedImage
// with our Giphy src (Teams normalizes the id to `x_{id}`) → delete the probe.
//
// Usage:
//   GIPHY_API_KEY=xxx CDP_HOST=100.85.206.8:9222 node scripts/gif-roundtrip-e2e.mjs
// Env: GIPHY_API_KEY (required), CDP_HOST (default 100.85.206.8:9222), CONV_ID (default 48:notes),
//      GIPHY_KIND (gifs|stickers, default gifs), QUERY (default "thank you").
import { WebSocket } from "ws"

const KEY = process.env.GIPHY_API_KEY
const HOST = process.env.CDP_HOST || "100.85.206.8:9222"
const CONV = process.env.CONV_ID || "48:notes"
const KIND = process.env.GIPHY_KIND === "stickers" ? "stickers" : "gifs"
const QUERY = process.env.QUERY || "thank you"
const fail = (m) => {
  console.error("FAIL:", m)
  process.exit(1)
}

// --- mirror of chat/src/lib/teams-gif.ts (kept in sync; the unit test guards the module itself) ---
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
const giphyEntryToItem = (g) => {
  const orig = g.images?.original
  const url = orig?.url
  if (!g.id || !url) return null
  const prev = g.images?.fixed_width ?? orig ?? {}
  return {
    id: g.id,
    url,
    previewUrl: prev.url ?? url,
    width: Number(orig.width) || 220,
    height: Number(orig.height) || 220,
  }
}
const buildGifContent = (item) => {
  const w = Number.isFinite(item.width) && item.width > 0 ? Math.round(item.width) : 220
  const h = Number.isFinite(item.height) && item.height > 0 ? Math.round(item.height) : 220
  return `<span><img itemscope="" itemtype="http://schema.skype.com/AnimatedImage" src="${esc(item.url)}" id="${esc(item.id)}" width="${w}" height="${h}"></span>`
}

if (!KEY) fail("GIPHY_API_KEY is required")

// Step 1 — Giphy search.
const gres = await fetch(
  `https://api.giphy.com/v1/${KIND}/search?api_key=${KEY}&q=${encodeURIComponent(QUERY)}&limit=5&rating=pg-13`,
)
if (!gres.ok) fail(`giphy http ${gres.status}`)
const items = ((await gres.json()).data ?? []).map(giphyEntryToItem).filter(Boolean)
if (!items.length) fail("giphy returned no usable items")
const pick = items[0]
const content = `<p>PSN94-E2E-GIF</p>${buildGifContent(pick)}`
console.log(`STEP1 giphy ok: ${items.length} ${KIND}; picked ${pick.id}`)

// CDP plumbing.
const tabs = await (await fetch(`http://${HOST}/json/list`)).json()
const tab = tabs.find((t) => t.type === "page" && /teams\.microsoft\.com\/v2/.test(t.url))
if (!tab) fail("no live Teams tab on the CDP host")
const connect = () => {
  const ws = new WebSocket(tab.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.on("message", (d) => {
    const m = JSON.parse(d)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  })
  const call = (method, params) =>
    new Promise((res) => {
      const mid = ++id
      pending.set(mid, res)
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
  const evaluate = (expression) =>
    call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }).then(
      (r) => r?.result?.result?.value ?? r,
    )
  return new Promise((res) => {
    ws.on("open", async () => {
      await call("Runtime.enable", {})
      res({ evaluate, close: () => ws.close() })
    })
  })
}

// The in-page skype-token mint (CA-proof — the browser makes its own authenticated calls).
const creds = `
  let bearer=null;
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith("msal.") && k.includes("accesstoken") && k.toLowerCase().includes("api.spaces.skype.com")) {
      try { const e=JSON.parse(localStorage.getItem(k)); if(e&&e.secret){bearer=e.secret;break;} } catch{}
    }
  }
  const az = await fetch("https://teams.microsoft.com/api/authsvc/v1.0/authz",{method:"POST",headers:{Authorization:"Bearer "+bearer,"Content-Type":"application/json"},body:"{}"});
  const j = await az.json(); const sk=j.tokens.skypeToken, base=j.regionGtms.chatService;`

const conn = await connect()

// Step 2 — send.
const sent = await conn.evaluate(`(async () => { try {
  ${creds}
  const cmid = String(1+Math.floor(Math.random()*9)) + Array.from({length:17},()=>Math.floor(Math.random()*10)).join("");
  const body = { content: ${JSON.stringify(content)}, messagetype:"RichText/Html", contenttype:"text", clientmessageid:cmid, imdisplayname:"", properties:{} };
  const r = await fetch(base + "/v1/users/ME/conversations/${CONV}/messages", {method:"POST",headers:{Authentication:"skypetoken="+sk,"Content-Type":"application/json"},body:JSON.stringify(body)});
  const jj = await r.json().catch(()=>({}));
  return { status:r.status, arrival: jj.OriginalArrivalTime };
} catch(e){ return {error:String(e&&e.message||e)}; } })()`)
if (sent.error || sent.status !== 201) fail(`send failed: ${JSON.stringify(sent)}`)
console.log(`STEP2 send ok: 201, arrival ${sent.arrival}`)

await new Promise((r) => setTimeout(r, 2500))

// Step 3 — read back + assert.
const back = await conn.evaluate(`(async () => { try {
  ${creds}
  const r = await fetch(base + "/v1/users/ME/conversations/${CONV}/messages?pageSize=15&view=msnp24Equivalent", {headers:{Authentication:"skypetoken="+sk}});
  const hit = ((await r.json()).messages||[]).find(m => (m.content||"").includes("PSN94-E2E-GIF"));
  return hit ? { content: hit.content, id: hit.id } : { none: true };
} catch(e){ return {error:String(e&&e.message||e)}; } })()`)
if (back.error || back.none) fail(`read-back failed: ${JSON.stringify(back)}`)
const okSchema = /schema\.skype\.com\/AnimatedImage/.test(back.content)
const okSrc = back.content.includes(pick.id) || back.content.includes("giphy.gif")
console.log(`STEP3 read-back: AnimatedImage=${okSchema} giphySrc=${okSrc}`)

// Step 4 — cleanup.
const del = await conn.evaluate(`(async () => { ${creds}
  const del = await fetch(base + "/v1/users/ME/conversations/${CONV}/messages/${back.id}", {method:"DELETE", headers:{Authentication:"skypetoken="+sk}});
  return del.status; })()`)
console.log(`STEP4 cleanup delete: ${del}`)
conn.close()

if (okSchema && okSrc) {
  console.log("\nE2E RESULT: PASS  (search → build → send → native round-trip → cleanup)")
  process.exit(0)
}
fail("round-trip assertions failed")
