// Name display preference (t161, PSN-90 Phase 2 item 2): one pure seam every rendered person-name
// goes through — message sender headers, DM conversation labels, reactor tooltips. Modes:
// "full" (as Teams sends it), "first" (org-suffix stripped, first given name), "regex" (a custom
// strip pattern). Org format this is built for: "Careen Tan - Group Office" → "Careen",
// "Glory Nguyen - Group Office [C]" → "Glory".
import type { TeamsConversation } from "./teams-client"

export type NameMode = "full" | "first" | "regex"

export interface NamePref {
  mode: NameMode
  /** The strip pattern for `mode: "regex"` — matches are removed. Invalid/empty → full name. */
  regex?: string
}

export const FULL_NAME: NamePref = { mode: "full" }

/** Strip the org suffix: everything from a " - " separator on, plus any trailing "[…]" tag. */
function stripOrgSuffix(name: string): string {
  return name
    .split(" - ")[0]
    .replace(/\s*\[[^\]]*\]\s*$/, "")
    .trim()
}

/** Format one person's display name per the preference. Never returns empty — a transform that
 *  eats the whole name falls back to the raw input. */
export function formatName(raw: string, pref: NamePref): string {
  const name = (raw || "").trim()
  if (!name) return name
  if (pref.mode === "first") {
    const base = stripOrgSuffix(name)
    return base.split(/\s+/)[0] || name
  }
  if (pref.mode === "regex" && pref.regex) {
    try {
      const out = name.replace(new RegExp(pref.regex, "gu"), "").trim()
      return out || name
    } catch {
      return name
    }
  }
  return name
}

/** Apply the preference to a conversation label. Only a person-named label (1:1 / the self Notes
 *  chat) is transformed — a group title is already a composed first-name list / topic, and running
 *  the strip over it would mangle the joins. */
export function formatConversationLabel(
  label: string,
  conv: Pick<TeamsConversation, "kind">,
  pref: NamePref,
): string {
  if (conv.kind === "oneOnOne") return formatName(label, pref)
  return label
}
