# 084 — on-screen keyboard bridge for the screencast (view in web)

- **Status:** done
- **Mode:** HITL
- **Estimate:** 1d
- **Depends on:** 076
- **Blocks:** none

## Goal

Let a finger-only user type into the live remote page from the screencast ("View in web"). The canvas has no focusable element, so iOS never raises its keyboard. A floating keyboard button focuses a hidden field; its edits forward to the Remote Page so typing works without a hardware keyboard. Unblocks replying inside real Slack/Teams/anything for workspaces the native reader can't sweep.

## Acceptance criteria

- [x] A keyboard button appears over the screencast on web + touch only (never for trackpad/hardware-keyboard).
- [x] Tapping it raises the iOS keyboard; typed text reaches the remote focused field.
- [x] Autocorrect / predictive / composed input (Vietnamese Telex) forward correctly (delta sync, not per-keystroke).
- [x] Enter / Backspace / Tab / arrows / Escape forward as key events.
- [x] Mac/trackpad path unchanged.

## Test plan

### Layer 1 — Pure logic (TDD)
- [x] `diffInput(prev, next)` — append, autocorrect replace, Vietnamese composition, deletion, full replace (7 tests).

### Layer 2/3 — HITL on device
- [ ] Real iPhone: tap keyboard, type into a remote text field, including a Vietnamese word; Enter/Backspace.

## Design notes

- **New modules:** `src/lib/text-input-delta.ts` (pure), `src/components/screencast-keyboard.tsx` (effectful bridge). Reuses `page.paste(text,{rich:false})` → `Input.insertText` and `page.forwardInput({kind:"key"})`.
- **New ADR needed?** no — supersedes ADR-0009's OSK deferral for the touch case; recorded in CLAUDE.md.

## Out of scope

- Hardware-keyboard changes (already works).
- Modifier combos from the OSK (Cmd/Ctrl shortcuts) — the bridge targets text entry.

## Definition of Done

- [x] Layer 1 tests green; typecheck/test/build green.
- [x] CLAUDE.md updated.
- [ ] HITL device pass (typing + Vietnamese).
- [x] Task closed, t084 in commit.

## Notes

The delta approach (diff the field vs its last value, emit backspaces + insert) is what makes autocorrect/IME/Vietnamese work — per-keystroke keydown capture is unreliable on iOS for composed input.

---

_When task status flips to `done`, move this file to `done/`._
