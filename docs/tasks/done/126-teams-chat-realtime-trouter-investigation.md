# 126 — teams chat: realtime via trouter (investigation → documented wall)

- **Status:** done (investigation; no code shipped — decision recorded)
- **Mode:** research
- **Related:** t113 (poll-first live sync), t125 (push uses the poll instead)

## Goal

Replace/augment the ~4s REST polling (t113) with Teams' realtime channel (trouter) for instant message
delivery + to feed push (t125). User asked to "keep probing trouter hard."

## Outcome: WALL (after 7 live probes, 2026-07-22)

Trouter is not usable by a headless/server-managed tab with a naive tap. Probed hard; recording why so a
future attempt doesn't repeat the dead ends. Full technical detail is in the `teams-trouter-realtime-findings`
memory; summary here.

### What the realtime channel is
- **Trouter = `wss://go.trouter.teams.microsoft.com/v4/c`** (socket.io **0.9** framing) → regional
  callback `pub-ent-*.trouter.teams.microsoft.com`. Runs on the **window** `WebSocket` (not a worker), so
  a document-start `window.WebSocket` wrapper DOES capture its frames (proven).
- It is a **tag-based doorbell**, NOT a message stream. Frames observed were only `trouter.connected`,
  `trouter.message_loss` (`droppedIndicators:[{tag:"messaging"|"messagingsync"|…, etag:<ts>}]`), and
  `pong`. Content is fetched by the client via a REST **delta-sync** pull after a doorbell.

### Why a tap doesn't work for us
- Even a fully-tapped connection (fresh tab AND the reloaded primary tab, 60–120s settle, foregrounded)
  received **no NewMessage frame** — only connect + message_loss + pings. Live per-tag doorbells require a
  **messaging-subscription registration** that never completed on a server-(re)connected tab.
- That registration is **flightproxy-wrapped** (`api.flightproxy.teams.microsoft.com/api/v2/ep/…`) and was
  not captured (a host-filtered network capture caught 0). It's likely gated on full interactive Teams init
  and/or a foreground/active-client heuristic a headless server tab won't satisfy.
- The classic simple alternative — the Skype/Teams HTTP long-poll (`endpoints`→`subscriptions`→`poll`) — is
  **410 Gone** on `apac.ng.msg.teams.microsoft.com` (Microsoft removed it).

### Probes (scratchpad)
`trouter-recon.mjs`, `trouter-resource-probe.mjs`, `longpoll-probe.mjs` (410), `trouter-tap-proof.mjs`
(tap works, no msg content), `trouter-registration-capture.mjs` (0 caught), `decisive-primary-tap.mjs` +
`reread-tap.mjs` (primary tab, still 0 msg frames).

## Decision
- **Notifications + live sync stay on the REST poll** (t113 client poll, t125 server-poll capture). The poll
  is near-realtime and reliable; trouter is not worth blocking on.
- To ever crack trouter: capture the flightproxy registration on a real working client (unfiltered, before
  its socket opens), decode the `message_loss` etag → `messagingsync` delta pull, and first confirm a
  non-foreground endpoint is even eligible for messaging doorbells (may be a hard no). Multi-session RE,
  uncertain payoff. Deferred.

## Side-effect to clean up later
Probing reloaded the user's primary Teams tab once and injected a harmless pass-through `window.WebSocket`
tap (no behavior change; gone on that tab's next close/navigate).

## Definition of Done
- [x] Realtime mechanism identified + the wall characterized; decision recorded (poll, not trouter).
- [x] Findings persisted to memory (`teams-trouter-realtime-findings`) for a future RE attempt.
- [x] Task → done, `t126` in commit.
