// Tool-activity disclosure for an assistant turn (steering): a shadcn Accordion that collapses the
// retrieval steps by default and expands to show each tool's input + a compact result summary.
// While a turn is still streaming with no text yet, the trigger shimmers.

import { Search01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { ShimmerText } from "./shimmer-text"

/** The UIMessage tool parts we render — `type` is `tool-{name}` or `dynamic-tool`. */
export interface ToolPart {
  type: string
  input?: unknown
  output?: unknown
}

const toolLabel = (type: string) =>
  type === "dynamic-tool" ? "tool" : type.replace(/^tool-/, "").replace(/_/g, " ")

/** A stable per-call key: the tool + its input identify the call across re-renders. */
function callKey(p: ToolPart): string {
  return `${p.type}:${JSON.stringify(p.input ?? null)}`
}

/** One line of result summary — row count for a list, else a short JSON head. */
function summarize(output: unknown): string {
  if (output == null) return "…"
  if (Array.isArray(output)) return `${output.length} result${output.length === 1 ? "" : "s"}`
  const s = JSON.stringify(output)
  return s.length > 120 ? `${s.slice(0, 120)}…` : s
}

export function ToolCalls({ parts, streaming }: { parts: ToolPart[]; streaming: boolean }) {
  if (parts.length === 0) return null
  const label = streaming
    ? "Searching your messages…"
    : `Searched ${parts.length} time${parts.length === 1 ? "" : "s"}`
  return (
    <Accordion className="w-full min-w-0" collapsible type="single">
      <AccordionItem className="border-none" value="tools">
        <AccordionTrigger className="gap-1.5 py-1 text-muted-foreground text-xs hover:no-underline">
          <span className="flex items-center gap-1.5">
            <HugeiconsIcon className="size-3.5" icon={Search01Icon} />
            {streaming ? <ShimmerText>{label}</ShimmerText> : label}
          </span>
        </AccordionTrigger>
        <AccordionContent className="pb-1">
          <ul className="flex min-w-0 flex-col gap-1.5 text-xs">
            {parts.map((p) => (
              <li
                className="min-w-0 rounded-md border border-border bg-muted/40 px-2 py-1.5"
                key={callKey(p)}
              >
                <div className="font-medium text-foreground">{toolLabel(p.type)}</div>
                {p.input !== undefined && (
                  <div className="mt-0.5 overflow-hidden break-all font-mono text-muted-foreground text-xs">
                    {JSON.stringify(p.input)}
                  </div>
                )}
                <div className="mt-0.5 break-words text-muted-foreground">
                  {summarize(p.output)}
                </div>
              </li>
            ))}
          </ul>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}
