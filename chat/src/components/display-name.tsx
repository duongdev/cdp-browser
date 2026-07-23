import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { formatName, type NamePref } from "../lib/display-name"

/** One person-name, formatted per the Names setting (PSN-92 E). When the preference shortens the name
 *  a shadcn tooltip reveals the full name on hover (decision 5 — only when shortened); an unshortened
 *  name renders as plain text with no tooltip noise. The single React name spot — sender headers,
 *  reactor names, reply chips. Body-embedded names (mentions / quote authors) can't be React nodes, so
 *  they use the delegated `BodyNameTooltip` over the same `data-fullname` contract. */
export function DisplayName({
  name,
  pref,
  className,
}: {
  name: string
  pref: NamePref
  className?: string
}) {
  const full = (name || "").trim()
  const formatted = formatName(full, pref)
  if (!full || formatted === full) return <span className={className}>{formatted || full}</span>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("cursor-default", className)}>{formatted}</span>
      </TooltipTrigger>
      <TooltipContent>{full}</TooltipContent>
    </Tooltip>
  )
}
