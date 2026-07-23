# 149 — chat design system: Airbnb-flavoured token layer (chat-only)

- **Status:** done
- **Mode:** HITL
- **Depends on:** nothing (Workstream A, foundational — blocks visual polish in B–K)

## Goal

Re-skin the `/chat` Teams app with an Airbnb-flavoured feel — generous whitespace, pill/rounded
geometry, one soft shadow tier, hairline borders, warm-neutral surfaces, modest weights — via CSS
theme tokens only. The `/` browser build stays byte-unchanged. Keep Manrope, no new deps, and a
**subtle warm accent** (not full Rausch): the coral is reserved for focus rings, unread, and the
own-message bubble tint; own/other contrast + read/unread hierarchy win over brand color.

## Approach

A chat-scoped token layer appended to `chat/src/index.css` **after** the shared
`@import "../../src/index.css"`, overriding the existing shadcn CSS variables (`--radius`,
`--border`, `--card`, `--primary`, `--ring`, surfaces, …) for both `:root` and `.dark`. Because the
chat app is served standalone at `/chat` (never sharing a DOM with the `/` build), the override
targets bare `:root`/`.dark` — no `data-app` scope needed. Shared `ui/*` components inherit the new
tokens with zero forks. One soft shadow tier rescales the `--shadow-sm`/`--shadow-md` theme vars the
`ui/*` components already consume. No component className changes were needed — the chat surfaces
already use radius-relative Tailwind tokens (`rounded-lg`/`rounded-md`) and semantic color tokens.

## Token table

| Token | Light | Dark | Role |
|---|---|---|---|
| `--radius` | `0.85rem` | `0.85rem` | Base radius; the whole `radius-sm..4xl` ramp scales off it → rounder geometry |
| `--background` | `oklch(0.995 0.003 80)` | `oklch(0.17 0.006 60)` | App canvas — warm paper, not clinical grey |
| `--card` / `--popover` | `oklch(1 0.002 80)` | `oklch(0.21 0.007 60)` | Elevated surfaces |
| `--muted` / `--accent` / `--secondary` | `oklch(0.965 0.006 80)` | `oklch(0.27 0.008 60)` | Others' message bubble, hover, skeletons |
| `--foreground` | `oklch(0.24 0.01 60)` | `oklch(0.97 0.004 80)` | Warm ink body text |
| `--primary` | `oklch(0.27 0.012 40)` | `oklch(0.9 0.006 70)` | Own-message bubble + primary buttons (warm ink, subtle) |
| `--muted-foreground` | `oklch(0.53 0.012 60)` | `oklch(0.7 0.01 70)` | Secondary/meta text |
| `--border` / `--input` | `oklch(0.9 0.006 70)` | `oklch(1 0 0 / 9–12%)` | Hairline borders |
| `--ring` | `oklch(0.64 0.19 15)` | `oklch(0.64 0.19 15)` | Warm coral — focus ring + unread accent |
| `--shadow-sm` / `--shadow-md` | soft warm-tinted | same | One elevation tier for popovers/menus |

## Acceptance criteria

- [x] Chat renders with the subtle accent + Airbnb geometry; `/` browser build byte-unchanged
      (verified: `git diff --stat` shows only `chat/src/index.css`; `pnpm build` clean, no `src/**` change).
- [x] Tokens documented (table above) and referenced by name, not inline.
- [x] Light + dark both covered (`:root` + `.dark` blocks).
- [x] No new component forks of `ui/*` (token-level override only).

## Verification

- [x] `pnpm chat:build` — clean
- [x] `pnpm typecheck` — clean
- [x] `pnpm test` — 1343 passed
- [x] `pnpm build` (`/`) — clean, no `src/**` changed → `/` byte-unchanged
- [x] `git diff --stat` — only `chat/src/index.css` + this task file

## Out of scope

- Command palette / keyboard nav (B/C), avatars (E), settings (F), unread visuals (J) — later
  workstreams that consume these tokens. Live screenshot review deferred to human (needs the remote
  Teams host).

## Notes

- Warmth is carried by geometry + whitespace + shadow + low-chroma ~60–80° surface hue, not brand
  voltage. No AI attribution.
