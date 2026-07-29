"use client"

import { ChevronLeft, ChevronRight } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { DayPicker } from "react-day-picker"
import { cn } from "@/lib/utils"

// shadcn-style Calendar over react-day-picker v10. v10 dropped the `classNames` prop's styling
// role in favor of direct `className` on sub-parts; the tailwind tokens below mirror the existing
// shadcn surface (popover/button/border) so it reads as one component.
export function Calendar({ className, ...props }: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      className={cn("p-3", className)}
      classNames={{
        months: "flex flex-col sm:flex-row gap-2",
        month: "flex flex-col gap-4",
        month_caption: "flex justify-center pt-1 relative items-center text-sm font-medium",
        caption_label: "text-sm font-medium",
        nav: "flex items-center gap-1",
        button_previous:
          "absolute left-1 top-0 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        button_next:
          "absolute right-1 top-0 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        month_grid: "w-full border-collapse space-y-1",
        weekdays: "flex",
        weekday: "text-muted-foreground rounded-md w-8 font-normal text-[0.8rem]",
        week: "flex w-full mt-2",
        day: "p-0 size-8 text-sm flex-1 flex items-center justify-center has-[button]:relative has-[button]:aspect-square",
        day_button:
          "inline-flex size-8 items-center justify-center rounded-md text-sm ring-offset-background hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        range_start: "bg-accent rounded-l-md",
        range_end: "bg-accent rounded-r-md",
        selected:
          "bg-primary text-primary-foreground rounded-md hover:bg-primary hover:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        today: "bg-accent text-accent-foreground rounded-md",
        outside: "text-muted-foreground/50",
        disabled: "text-muted-foreground/30",
        hidden: "invisible",
      }}
      components={{
        Chevron: ({ orientation }) => (
          <HugeiconsIcon
            className="size-4"
            icon={orientation === "left" ? ChevronLeft : ChevronRight}
          />
        ),
      }}
      {...props}
    />
  )
}
