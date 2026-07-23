# t161 — Identity display: name preference + group facepile avatars

Status: done
Depends on: t160
Scope: `/chat` + `web/server.mjs` conversations payload + `core/settings-store.js` key allowlist.
Plan: PSN-90 Phase 2, workstream N (items 2/12).

## What shipped

### 1. Name display preference (item 2)

One pure seam — `chat/src/lib/display-name.ts` `formatName(raw, pref)` — every rendered person
name goes through: message sender headers, 1:1 conversation labels (list rows + thread header),
reactor tooltips. Modes: **full** (default), **first** (org suffix from `" - "` on + trailing
`[…]` stripped, first given name: `"Careen Tan - Group Office"` → `Careen`,
`"Glory Nguyen - Group Office [C]"` → `Glory`), **regex** (custom strip pattern; invalid/
all-consuming pattern falls back to the full name). Group titles are never transformed (already a
composed first-name list, decision round-2 #2). TDD'd.

Setting lives in the sheet (Names: Full/First/Custom segmented + a pattern input with a live
preview line), persisted per device in server ui-state (`chatNameDisplay_<deviceId>` +
`chatNameRegex_<deviceId>`, allowlisted in `core/settings-store.js`).

### 2. Group facepile avatars (item 12)

`GET/POST /api/teams/conversations` now stamps `memberIds` (first ≤3 non-self member oids from the
title-resolution roster) on group rows. `FacepileAvatar` (`user-avatar.tsx`) renders the Teams-look
composite — two overlapping photo circles in the same fixed box a single avatar uses (no layout
shift), each with the existing Graph-photo proxy + per-circle initials fallback. Group rows with a
known roster use it; 1:1/self keep the single avatar.

## Verification

- `vitest run chat/src/lib` — 191 pass (display-name + chat-settings suites extended).
- `tsc --noEmit`, biome, `node --check web/server.mjs` clean.
- HITL: name modes + facepile reviewed on the preview deploy.
