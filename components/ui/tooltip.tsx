"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

import { cn } from "@/lib/utils"

// Thin wrapper over Base UI's Tooltip, styled in the app's warm popover
// language. Base UI is already a dependency (see button/dialog/select), so this
// adds no new library. The provider sets a shared open/close delay so tooltips
// across the composer feel consistent; wrap the app (or a subtree) once with
// <TooltipProvider>, then use <Tooltip content="…"> around any trigger.
//
// Accessibility: Base UI wires aria-describedby from trigger → popup, and the
// tooltip is keyboard- and focus-reachable. Callers should STILL pass an
// aria-label on icon-only triggers (the tooltip is a hint, not the accessible
// name) — and a native `title` is a harmless progressive-enhancement fallback.

function TooltipProvider({
  delay = 350,
  closeDelay = 0,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider delay={delay} closeDelay={closeDelay} {...props} />
  )
}

// One-shot convenience: <Tooltip content="Attach a file"><Button …/></Tooltip>.
// `content` empty/absent → renders the child alone (no tooltip), so a caller can
// conditionally enable it without branching in JSX.
function Tooltip({
  content,
  side = "top",
  sideOffset = 6,
  children,
}: {
  content?: React.ReactNode
  side?: TooltipPrimitive.Positioner.Props["side"]
  sideOffset?: number
  children: React.ReactNode
}) {
  if (!content) return <>{children}</>
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger
        render={children as React.ReactElement}
        data-slot="tooltip-trigger"
      />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} sideOffset={sideOffset}>
          <TooltipPrimitive.Popup
            data-slot="tooltip"
            className={cn(
              "z-50 select-none rounded-lg border border-border/70 bg-popover px-2.5 py-1.5 text-xs font-medium text-popover-foreground shadow-soft-lg",
              "origin-[var(--transform-origin)] transition-[transform,opacity] data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0",
              "motion-reduce:transition-none motion-reduce:data-[starting-style]:scale-100 motion-reduce:data-[ending-style]:scale-100",
            )}
          >
            {content}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

export { Tooltip, TooltipProvider }
