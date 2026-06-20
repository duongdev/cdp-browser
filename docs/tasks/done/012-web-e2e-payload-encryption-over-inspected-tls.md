# 012 — web E2E payload encryption over inspected TLS

- **Status:** done
- **Mode:** AFK
- **Estimate:** 1d
- **Depends on:** 007, 008, 011
- **Blocks:** none

## Goal

Add an opt-in end-to-end encryption mode so the web build's content stays hidden
even when a corporate TLS-intercepting proxy decrypts the HTTPS. Every `/api`
request/response body and all SSE event data is wrapped in an AES-256-GCM envelope
keyed by a PBKDF2 key the proxy never sees (passphrase entered in the browser,
matched by an env passphrase on the server). After the proxy strips TLS it's left with
ciphertext blobs. Transparent at the transport seam — the renderer, streaming
channel, and notifications are unchanged.

## Why now

The target device is managed, no-admin, TLS-inspected by a corporate proxy, and can't run a tunnel
(no Tailscale/SSH egress). HTTPS to the deployment is therefore readable by IT today.
App-layer E2E is the only mechanism that keeps content (screencast frames, input,
URLs, notification text) opaque to network content inspection on that device.

## Acceptance criteria

- [ ] E2E is ON iff the server has `E2E_PASSPHRASE` set; otherwise plaintext (unchanged).
- [ ] `GET /api/crypto-params` returns `{ e2e, salt, iterations, verifier }` (salt public).
- [ ] Browser prompts for the passphrase when `e2e` is on, derives a non-extractable
      AES-GCM key (PBKDF2-SHA256, served iters, served salt), and **verifies** it by
      decrypting `verifier`; wrong passphrase shows a re-enter overlay before connecting.
- [ ] Every `/api` body + every SSE `data:` is an AES-GCM envelope `base64(iv‖ct‖tag)`
      when E2E is on; server seals/opens with `node:crypto` using the env-derived key.
- [ ] Passphrase persists in `sessionStorage` (cleared on tab close), never on disk.
- [ ] With E2E off, payloads are plaintext exactly as before (no regression).
- [ ] `pnpm test` / `pnpm typecheck` / `pnpm check` green.

## Test plan

### Layer 1 — Pure logic (TDD)

- [ ] `crypto-envelope` (node side, `node:crypto`) — `seal(obj,key)` then `open(str,key)`
      round-trips; `open` with the wrong key throws (GCM auth fail); IV is random per call.
- [ ] Cross-impl: a payload sealed by the node module opens with the WebCrypto module
      under the same derived key (Node exposes WebCrypto, so both run under vitest).

### Layer 2 — Manual smoke (CDP/IPC) — local, passphrase set

- [ ] Boot server with `E2E_PASSPHRASE=…`; `/api/crypto-params` returns `e2e:true` + salt.
- [ ] Capture an SSE frame off the wire → it's ciphertext (no JPEG header), and decrypts
      with the right key only.

### Layer 3 — Visual review (Chrome DevTools MCP)

- [ ] E2E on: passphrase overlay appears; correct passphrase → app loads + screencast
      renders; wrong passphrase → re-enter overlay, no content.
- [ ] devtools Network shows `/api/*` bodies + SSE data as opaque base64.

## Design notes

- **Contracts changed:** new `GET /api/crypto-params`. All `/api` bodies + SSE data
  become envelopes when E2E is on. No renderer/UI contract change (seam is the transport).
- **New modules:** `crypto-envelope.js` (node/`node:crypto`, server) + a WebCrypto
  twin in `src/lib/` (browser). Shared envelope format + KDF params.
- **New ADR needed?** no — extends ADR-0006 (addendum).

```
client: seal(json) = base64(iv ‖ AES-GCM(json, K))   → request body / stream frame
server: open(body) → json ;  seal(reply)/seal(sse-data) → client open()
K = PBKDF2-SHA256(passphrase, salt(from /api/crypto-params), iters)   # passphrase never sent
```

## Out of scope

- Defeating endpoint screen/keystroke capture (EDR) — out of scope of any network crypto.
- Hiding metadata (destination/volume/timing) — visible regardless.
- Encrypting static assets / the SSO login — app shell only, no content.
- WebTransport/HTTP-3.

## Definition of Done

- [ ] Layer 1 tests green; Layer 2 + 3 verified locally (E2E on and off).
- [ ] `pnpm test` / `pnpm typecheck` / `pnpm check` green.
- [ ] No AI attribution; t012 in branch + commit.
- [ ] Deploy note: set `E2E_PASSPHRASE` on the server to enable; pick a long passphrase.
- [ ] Task closed: status → done, moved to `done/`.

## Notes

Honest bound: this defeats *content inspection/DLP logging* on a TLS-MITM device. It
does not defeat endpoint screen capture, nor hide that you use the deployment. The
verifier + known-format frames are offline-crack oracles → a strong passphrase is
mandatory; PBKDF2 raises the per-guess cost.
