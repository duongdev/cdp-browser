# 086 — fix notification icons (serve local) and screencast keyboard delete

- **Status:** done
- **Mode:** HITL
- **Estimate:** 0.5d
- **Depends on:** 084
- **Blocks:** none

## Goal

Two HITL bugs: (1) Slack and Outlook notification icons never loaded — they hotlinked external favicon CDNs (`a.slack-edge.com`, `outlook.office365.com`) that a corporate TLS-intercepting proxy blocks or that need auth, so `onError` hid them (only Teams' public CDN survived). (2) The screencast on-screen keyboard could type but not delete — synthetic key events carried no `keyCode`, so the remote's `Input.dispatchKeyEvent` (which reads `windowsVirtualKeyCode: e.keyCode`) ignored Backspace/Enter/arrows.

## Acceptance criteria

- [x] Adapter icons are served same-origin (`/icons/{teams,outlook,slack}.svg`, original simple tiles); always load regardless of network.
- [x] Slack sweep entries use the local Slack icon too.
- [x] Backspace deletes: in-field deletes ride the input delta (Backspace key with VK 8); empty-field Backspace forwards from keydown.
- [x] Enter / Tab / arrows / Escape forward with correct virtual key codes.
- [x] Typing / autocorrect / composed input unchanged (input delta).

## Test plan

### Layer 1 — Pure (TDD)
- [x] `synthKey` carries VK codes (Backspace 8, Enter 13, arrows…); `keyDownAction` routes Backspace by field-emptiness and forwards non-text keys (`screencast-keys.test.ts`).

### Layer 3 — Visual / device
- [x] Local SVG icons load (harness: naturalWidth 32 for all three).
- [ ] On-device: type + delete + Enter into a remote field (HITL).

## Design notes

- **New modules:** `src/lib/screencast-keys.ts` (pure VK map + keydown routing) + `public/icons/*.svg`. `screencast-keyboard.tsx` now delegates to it.
- **Root cause:** `forwardInput` key path sends `windowsVirtualKeyCode: e.keyCode`; the synthetic events had none. Fixed by `synthKey` supplying VK codes.
- **New ADR needed?** no.

## Notes

External favicon hotlinking is fragile behind a corporate proxy — same-origin assets are the durable fix. The keyboard's delete now has two non-overlapping paths (input delta for in-field, keydown for empty-field) so iOS soft-keyboard event quirks can't drop a delete.

---

_When task status flips to `done`, move this file to `done/`._
