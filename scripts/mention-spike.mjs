#!/usr/bin/env node
// PSN-120 spike (NOT a CI test): send the SAME @mention content three ways and check which shape
// Teams actually treats as a real mention. The oracle is `48:mentions` — the service-side pseudo
// conversation Teams fans a message into when it mentions the signed-in user. A variant that lands
// there was a genuine mention; one that doesn't was only mention-shaped markup.
//
// Variants (all self-mention so no colleague is spammed):
//   v1  properties.mentions entries WITHOUT mri            (today's shipped shape — the suspected bug)
//   v2  entries with mri only                              (mri restored, native extras still absent)
//   v3  entries with @type + mri + mentionType             (byte-identical to native Teams)
//
// Usage: CDP_HOST=100.85.206.8:9222 CONV_ID=48:notes node scripts/mention-spike.mjs
import { WebSocket } from "ws"

const HOST = process.env.CDP_HOST || "100.85.206.8:9222"
const CONV = process.env.CONV_ID || "48:notes"
const KEEP = process.env.KEEP === "1"

const tabs = await (await fetch(`http://${HOST}/json/list`)).json()
const tab = tabs.find((t) => t.type === "page" && /teams\.microsoft\.com\/v2/.test(t.url))
if (!tab) {
  console.error("FAIL: no live Teams tab")
  process.exit(1)
}
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
await new Promise((res) => ws.on("open", res))
await call("Runtime.enable", {})
const evaluate = (expression) =>
  call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }).then(
    (r) => r?.result?.result?.value ?? r,
  )

const creds = `
  let bearer=null;
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith("msal.") && k.includes("accesstoken") && k.toLowerCase().includes("api.spaces.skype.com")) {
      try { const e=JSON.parse(localStorage.getItem(k)); if(e&&e.secret){bearer=e.secret;break;} } catch{}
    }
  }
  const az = await fetch("https://teams.microsoft.com/api/authsvc/v1.0/authz",{method:"POST",headers:{Authorization:"Bearer "+bearer,"Content-Type":"application/json"},body:"{}"});
  const j = await az.json(); const sk=j.tokens.skypeToken, base=j.regionGtms.chatService;
  const selfOid = JSON.parse(atob(bearer.split(".")[1])).oid;
  const selfMri = "8:orgid:" + selfOid;`

const stamp = process.env.STAMP || `PSN120-${Math.floor(Math.random() * 1e6)}`
console.log(`stamp=${stamp} conv=${CONV}\n`)

const out = await evaluate(`(async () => { try {
  ${creds}
  // Resolve the self display name so the tokens match a real mention exactly. Read it off our own
  // most recent sent message's imdisplayname (no extra scope needed).
  let name = ${JSON.stringify(process.env.SELF_NAME || "")};
  if (!name) {
    const mr = await fetch(base + "/v1/users/ME/conversations/48%3Anotes/messages?pageSize=30&view=msnp24Equivalent", {headers:{Authentication:"skypetoken="+sk}});
    const ms = (await mr.json()).messages || [];
    name = (ms.find(m => m.imdisplayname) || {}).imdisplayname || "";
  }
  const tokens = String(name).split(/\\s+/).filter(Boolean);
  if (!tokens.length) return { error: "no self display name" };

  const spans = tokens.map((t,i)=>'<span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="'+i+'">'+t+'</span>').join("&nbsp;");
  const shapes = {
    v1: tokens.map((t,i)=>({ itemid:i, displayName:t })),
    v2: tokens.map((t,i)=>({ itemid:i, mri:selfMri, displayName:t })),
    v3: tokens.map((t,i)=>({ "@type":"http://schema.skype.com/Mention", itemid:i, mri:selfMri, mentionType:"person", displayName:t })),
    // v4: the full native shape but with a BARE oid where the mri belongs — what the 1:1 roster
    // hands the composer today (otherMrisFromId returns the conv id's raw bare-oid segment).
    v4: tokens.map((t,i)=>({ "@type":"http://schema.skype.com/Mention", itemid:i, mri:selfOid, mentionType:"person", displayName:t })),
  };
  const sent = {};
  for (const v of ${JSON.stringify((process.env.VARIANTS || "v1,v2,v3").split(","))}) {
    const cmid = String(1+Math.floor(Math.random()*9)) + Array.from({length:17},()=>Math.floor(Math.random()*10)).join("");
    const body = {
      content: "<p>" + spans + "&nbsp;${stamp}-" + v + "</p>",
      messagetype: "RichText/Html",
      contenttype: "text",
      clientmessageid: cmid,
      imdisplayname: name,
      properties: { mentions: JSON.stringify(shapes[v]) },
    };
    const r = await fetch(base + "/v1/users/ME/conversations/" + encodeURIComponent(${JSON.stringify(CONV)}) + "/messages", {method:"POST",headers:{Authentication:"skypetoken="+sk,"Content-Type":"application/json"},body:JSON.stringify(body)});
    const jj = await r.json().catch(()=>({}));
    sent[v] = { status: r.status, id: jj.OriginalArrivalTime };
    await new Promise(z=>setTimeout(z,1200));
  }
  return { name, selfMri, sent };
} catch(e){ return {error:String(e&&e.message||e)}; } })()`)

if (out?.error) {
  console.error("FAIL:", out.error)
  process.exit(1)
}
console.log(`self="${out.name}" mri=${out.selfMri}`)
for (const [v, s] of Object.entries(out.sent)) console.log(`  ${v}: http ${s.status} id=${s.id}`)

console.log("\nwaiting 12s for the mention fan-out …")
await new Promise((r) => setTimeout(r, 12000))

const check = await evaluate(`(async () => { try {
  ${creds}
  const r = await fetch(base + "/v1/users/ME/conversations/48%3Amentions/messages?pageSize=40&view=msnp24Equivalent", {headers:{Authentication:"skypetoken="+sk}});
  const msgs = (await r.json()).messages || [];
  const hits = msgs.filter(m => (m.content||"").includes(${JSON.stringify(stamp)})).map(m=>({ id:m.id, content:m.content }));
  return { total: msgs.length, hits };
} catch(e){ return {error:String(e&&e.message||e)}; } })()`)

console.log(`\n48:mentions scanned=${check.total}  hits=${check.hits?.length ?? 0}`)
for (const v of Object.keys(out.sent)) {
  const got = (check.hits || []).some((h) => h.content.includes(`${stamp}-${v}`))
  console.log(`  ${v}: ${got ? "MENTION REGISTERED ✓" : "not a mention ✗"}`)
}

if (!KEEP) {
  const ids = Object.values(out.sent)
    .map((s) => s.id)
    .filter(Boolean)
  const del = await evaluate(`(async () => { ${creds}
    const r = [];
    for (const mid of ${JSON.stringify(ids)}) {
      const d = await fetch(base + "/v1/users/ME/conversations/" + encodeURIComponent(${JSON.stringify(CONV)}) + "/messages/" + mid, {method:"DELETE", headers:{Authentication:"skypetoken="+sk}});
      r.push(d.status);
    }
    return r; })()`)
  console.log(`\ncleanup deletes: ${JSON.stringify(del)}`)
}
ws.close()
