# 013 — event-driven web input (hover gate) + POST fallback backpressure

- **Status:** done
- **Mode:** HITL
- **Estimate:** 0.5d
- **Depends on:** 011
- **Blocks:** none

## Goal

When the streaming input channel (t011) can't activate — because a proxy in front
of the container buffers the request body (the default for nginx/an SSO proxy without
`proxy_request_buffering off`) — the web build falls back to one fire-and-forget
`POST /api/cdp-batch` per `requestAnimationFrame`. Streaming a *continuous hover*
(~60 `mouseMoved`/sec) floods the browser's ~6-connection-per-host limit; the POSTs
serialize, back up, and (being fire-and-forget) can arrive out of order — so the cursor
lags and **clicks land seconds late or appear ignored**, queued behind a permanent move
backlog. After this task web mouse input is **event-driven**: (1) a **hover gate** holds
buttons-up moves and emits one resting position only when the cursor stops, so hover no
longer floods (drag moves bypass it and track live; clicks carry their own coords); and
(2) the fallback applies **single-flight backpressure** — one `/api/cdp-batch` in flight,
consecutive `mouseMoved` collapsed to the latest, clicks/wheel/keys ordered and never
dropped — bounding the remaining drag burst to link RTT.

## Why now

The app is live behind an SSO proxy; the operator has not set `proxy_request_buffering
off`, so the streaming path is permanently on the POST fallback (its designed-for
safe state). The fallback was never meant to carry interactive input at this volume.
This is the difference between "usable" and "unusable" on the deployed web build.

## Acceptance criteria

- [x] Buttons-up (hover) moves emit one resting position after the cursor stops, not a
      continuous stream; a click/press/drag cancels a held resting move.
- [x] Drag moves (a button held) bypass the gate and track live; a click with no preceding
      resting move still lands at the right coordinates.
- [x] Fallback POSTs are single-flight: no new `/api/cdp-batch` request starts while a
      previous one is unresolved.
- [x] While a request is in flight, accumulated batches merge; runs of consecutive
      `mouseMoved` collapse to the latest, preserving order of clicks/wheel/keys.
- [x] A rejected POST does not wedge the queue (it continues with the next pending).
- [x] The streaming path, when active, is unchanged (no backpressure/collapse applied).
- [x] `pnpm test` / `pnpm typecheck` / `pnpm check` green.

## Test plan

### Layer 1 — Pure logic (TDD)

- [x] `input-coalesce` `createHoverGate` — emits the resting move on stop; keeps only the
      latest while moving; re-arms the timer on each move; `cancel()` drops the held move.
- [x] `input-coalesce` `createSingleFlight` — holds subsequent sends until the in-flight
      promise resolves; on resolve sends one merged batch; survives a rejected post.
- [x] `input-coalesce` `createSingleFlight` — empty pending after a send is a no-op.
- [x] `cdp-web-transport` `collapseMoves` — consecutive `mouseMoved` collapse to the
      last; a click breaks the run (both positions kept); wheel/key preserved.

### Layer 2 — Manual smoke (CDP/IPC)

n/a — no main-process or server change; the server `/api/cdp-batch` contract is
unchanged (still `{ items }`).

### Layer 3 — Visual review

- [ ] `pnpm web` against a live Remote Browser with the stream forced off (buffering
      proxy or `SUPPORTS_REQUEST_STREAMING` false): hover over a link, stop → the page's
      hover state updates (one resting move); click immediately registers at the cursor;
      drag-select selects text; drag-n-drop works; no seconds-late / ignored clicks.
      Confirmed by the user — input is responsive and clicks register (paired with t014
      for correct landing position).

## Design notes

- **Contracts changed:** none external. `createInputChannel`'s fallback callback takes
  a `Batch<Cmd>` (was a serialized line) so the fallback can inspect/merge items;
  it serializes for the stream itself.
- **New modules:** none. Added to `input-coalesce.ts`: `createHoverGate<T>` (emit on stop)
  and `createSingleFlight<T>` (generic single-flight queue with an injected `merge`).
  `collapseMoves(items)` (CDP-specific merge) lives in `cdp-web-transport.ts`.
- **New ADR needed?** no — refines the t011 fallback within ADR-0006.

```ts
// generic, in input-coalesce.ts
createHoverGate<T>({
  delay: (cb) => () => void,              // production: setTimeout(cb, 80ms) → clearTimeout
  emit: (item: T) => void,                // production: batcher.coalesce
}): { move(item: T): void; cancel(): void }

createSingleFlight<T>({
  post: (items: T[]) => Promise<unknown>, // production: POST /api/cdp-batch {items}
  merge: (items: T[]) => T[],             // production: collapseMoves
}): { push(items: T[]): void }
```

Routing in the transport's `send` for `Input.dispatchMouseEvent`:

```
mouseMoved + buttons  → drag: batcher.coalesce  (tracks live)
mouseMoved, no buttons → hover.move             (emit one position on stop)
mousePressed/Released  → hover.cancel(); batcher.immediate
mouseWheel             → batcher.append
```

Flow on the fallback:

```
batcher (rAF coalesce) → inputChannel.send(batch)
   stream up?  → enqueue NDJSON frame (unchanged, no backpressure)
   else        → singleFlight.push(batch.items)
                   in flight? accumulate; on resolve → merge → one POST {items}
```

## Out of scope

- The E2E branch (sealed batches already post on a serialized promise chain; adding
  collapse there is a separate, smaller follow-up).
- Tuning the proxy buffering itself (operator-owned; documented in t011).

## Definition of Done

- [x] Layer 1 tests written and green.
- [x] `pnpm check` (touched files) / `pnpm typecheck` / `pnpm test` green.
- [x] CLAUDE.md / `src/lib/CLAUDE.md` updated for the changed `input-coalesce` surface.
- [x] No commented-out code, no `console.log` debris, no AI attribution.
- [x] Task closed: status → done, file moved to `docs/tasks/done/`, t013 in commit.

## Notes

The fix is symmetric with the streaming design's intent: bound the in-flight work to
what the link can carry. Collapsing intermediate `mouseMoved` is safe for selection
(selection is anchor + current focus, not the path) and matches the product's "jump
to the latest position" feel over replaying a stale trail.
