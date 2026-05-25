import { Accordion as AccordionPrimitive } from "radix-ui"
import type * as React from "react"
import { cn } from "@/lib/utils"

function Accordion({ className, ...props }: React.ComponentProps<typeof AccordionPrimitive.Root>) {
  return (
    <AccordionPrimitive.Root
      className={cn("flex w-full flex-col", className)}
      data-slot="accordion"
      {...props}
    />
  )
}

function AccordionItem({
  className,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Item>) {
  return (
    <AccordionPrimitive.Item
      className={cn("not-last:border-b", className)}
      data-slot="accordion-item"
      {...props}
    />
  )
}

function AccordionTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex flex-1">
      <AccordionPrimitive.Trigger
        className={cn(
          // Compact, quiet folder header. No built-in chevron — the caller composes
          // its own disclosure affordance (and can rotate it via the
          // `group-aria-expanded/accordion-trigger` state). No underline/border.
          "group/accordion-trigger flex flex-1 items-center gap-1.5 rounded-md text-left outline-none transition-colors disabled:pointer-events-none disabled:opacity-50",
          className,
        )}
        data-slot="accordion-trigger"
        {...props}
      >
        {children}
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  )
}

function AccordionContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content
      className="overflow-hidden data-open:animate-accordion-down data-closed:animate-accordion-up"
      data-slot="accordion-content"
      {...props}
    >
      <div className={cn("pt-0.5", className)}>{children}</div>
    </AccordionPrimitive.Content>
  )
}

export { Accordion, AccordionContent, AccordionItem, AccordionTrigger }
