# ADR-0025: Serve `/mcp` on the tailnet origin

- **Status:** Accepted — decision 2 (`/mcp` stays read-only) amended by ADR-0026; the proxy route and the `Origin` gate (decisions 1, 3) stand unchanged
- **Date:** 2026-08-03
- **Amends:** ADR-0024 decision 6 (security posture). Decisions 1–5 stand unchanged.

## Context

ADR-0024 shipped the read-only MCP server at `/mcp` and deliberately did **not** reverse-proxy it:
"`/mcp` is **not** reverse-proxied to the public origin, so it never leaves the host. Remote access
rides the operator's Tailscale."

That sentence encodes an assumption that is no longer true: that the proxied origin is *public*.
It is not. `portal.dp.dustin.one` resolves — from public resolvers, `8.8.8.8` and `1.1.1.1` alike —
to `100.117.176.112`, a Tailscale CGNAT address. The record is public; the route is not. Reaching
the origin at all already requires being on the tailnet.

So the deployment has two surfaces sitting behind the *same* network boundary, gated differently:

| Surface | Proxied to the origin | Capability |
|---|---|---|
| `/api/chat/*` | yes | read **and write** — `reply`, `react`, `edit`, `delete`, `upload-*` |
| `/mcp` | no | read-only |

The strictly less privileged surface is the one that is harder to reach. The posture is inverted:
an operator on the tailnet can already send a Teams message as Dustin through `/api/chat/reply`, but
cannot ask a question about his own chat history over MCP. "Remote access rides the operator's
Tailscale" describes what the chat surface already does — `/mcp` is the one endpoint that opted out
of it.

The forcing case: Hermes replaces the in-app assistant (PSN-131). It runs off-host and needs the
retrieval surface. Without `/mcp` on the origin the options are all worse — re-expose the same
reads as new REST routes (a second retrieval surface, exactly what ADR-0024 decision 1 exists to
prevent), or tunnel port 7810 separately (a second, undocumented boundary).

## Decision

Reverse-proxy `/mcp` through `web/server.mjs` to `CHAT_SERVER_URL`, on the same path and with the
same verbatim pass-through as `/api/chat/*`.

1. **The tailnet is the auth boundary, and it is the same one the chat surface already uses.** No
   new authentication layer for `/mcp`. Adding one here while `/api/chat/reply` — which *writes to
   other people's threads* — has none would be security theatre pointed at the wrong endpoint. If
   the chat surface ever needs auth, both get it together, in one ADR.

2. **`/mcp` stays read-only.** ADR-0024 decision 3 is unchanged and becomes more load-bearing, not
   less: it is what makes this expansion cheap. No send/react/edit/mark-read tool. The blast radius
   of a tailnet-local attacker reaching `/mcp` is disclosure of chat history they can already read
   through `/api/chat/history`.

3. **The `Origin` gate is unchanged and stays load-bearing.** It still allows absent + localhost and
   rejects everything else. Non-browser MCP clients (Hermes, Claude Code, curl) send no `Origin` and
   pass. A DNS-rebinding page — attacker DNS pointing `evil.com` at `100.117.176.112`, loaded by a
   browser that *is* on the tailnet — arrives with `Origin: http://evil.com` and is rejected. The
   gate is not weakened by proxying; it is the reason proxying is safe. `server.mjs` forwards request
   headers verbatim (it rewrites only `host`), so the header reaches the gate intact.

4. **Route it before the E2E body decode, exactly like `/api/chat/*`.** `/mcp` is plaintext JSON-RPC
   and must not ride the public E2E envelope. Same placement in the dispatch chain, same 502-on-
   upstream-error behaviour, same "never crash this server" contract.

5. **No change to `mcp.ts`.** Stateless transport, per-request server construction, tool surface —
   all unchanged. This ADR moves a boundary in `server.mjs`; it does not touch the MCP server.

## Consequences

- **+** Posture is consistent: one origin, one boundary, and the read-only surface is no longer the
  hardest one to reach. The rule becomes statable in a sentence — *everything on the chat surface is
  tailnet-gated; writes exist, reads are strictly weaker.*
- **+** Off-host MCP clients work without a second tunnel or a second retrieval surface. PSN-132
  becomes configuration rather than code, and ADR-0024 decision 1 (one data plane) survives contact
  with a remote consumer.
- **+** The `Origin` gate gets exercised by real traffic instead of only by tests.
- **−** `/mcp` is now reachable by anything on the tailnet, including devices that are not the
  operator's workstation (phones, the iPad, any future tailnet node). Read-only bounds the damage,
  but the honest statement is: tailnet membership now implies read access to synced chat history.
  Acceptable because it already implied *write* access to Teams.
- **−** One more path in `server.mjs`'s dispatch chain whose ordering matters. It must stay above the
  `/api/` 404 and outside the E2E decode; a future refactor that reorders the chain can silently
  break it. Covered in *Watch out for*.
- **−** ADR-0024's decision 6 can no longer be read standalone — a reader who stops there gets the
  wrong posture. Mitigated by the Status line on 0024 pointing here.

## Alternatives

- **Leave `/mcp` localhost-only; add REST routes for what Hermes needs.** Rejected: it rebuilds the
  retrieval surface a third time (assistant tools, MCP tools, now REST), which is precisely the
  duplication ADR-0024 decision 1 exists to prevent. It also lands the *new* surface outside the
  Origin gate.
- **Leave it localhost-only; tunnel 7810 to the Hermes host separately.** Rejected: a second,
  undocumented network boundary with its own lifecycle, to reach a service already exposed on a
  boundary that works. More moving parts for strictly less clarity.
- **Proxy `/mcp` and add a bearer token.** Rejected *for now*, not on principle. A token on the
  read-only endpoint while the write endpoints next to it have none secures the wrong door and
  invites the belief that the surface is authenticated. When the chat surface gets auth, it gets it
  as one decision covering `/api/chat/*` and `/mcp` together.
- **Widen the `Origin` gate to allow the portal origin.** Rejected: nothing needs it. The panel talks
  to `/api/chat/assistant/*`, never to `/mcp`. Allowing a browser origin would give up the
  DNS-rebinding protection for no consumer.

## Watch out for

- **Dispatch order in `server.mjs` is load-bearing.** `/mcp` must be matched before the E2E body
  decode and before the `/api/` 404, same as `/api/chat/*`. Move it below either and it breaks in a
  way that looks like an MCP bug, not a routing bug.
- **The public DNS record is misleading.** `portal.dp.dustin.one` looks internet-facing and resolves
  from any public resolver. It is CGNAT (`100.64.0.0/10`) and unroutable off the tailnet. Do not read
  the hostname as evidence of a public origin — check the address. Equally: do not assume the record
  will *stay* CGNAT. If that origin is ever pointed at a routable address, this ADR's premise is
  void and `/mcp` must come back off the proxy in the same change.
- **`Origin: null` is not `Origin: absent`.** Sandboxed iframes and some redirect chains send the
  literal string `null`, which is truthy and correctly rejected today. Anyone "fixing" the gate to
  treat it as absent reopens the rebinding vector.
- **Streamable HTTP holds the response open.** `proxyChatHttp` pipes verbatim and is fine, but a
  future buffering or response-rewriting layer in the proxy would break MCP streaming while leaving
  `/api/chat/*` working — an asymmetry that will not be obvious from the symptom.
- **`/mcp` is only as complete as `chat.db` + Substrate reach** (ADR-0024). Remote clients hit the
  same `substrate:true` preview rows as local ones; proxying changes reachability, not completeness.
