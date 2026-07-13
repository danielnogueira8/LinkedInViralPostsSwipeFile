"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"
import {
  type MediaScrollTarget,
  shouldPreventMediaKeyScroll,
  shouldPreventMediaTouchMove,
  shouldPreventMediaWheel,
} from "@/lib/media-dialog-scroll-guard"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

// Media viewers sit above image-heavy feeds. Base UI's full modal mode changes
// <body> overflow, which invalidates those image layers and makes them flash.
// trap-focus preserves focus trapping and assistive-tech isolation without the
// body mutation; the fixed backdrop still owns outside pointer/touch input.
function MediaDialog({
  open,
  ...props
}: Omit<DialogPrimitive.Root.Props, "modal" | "open"> & { open: boolean }) {
  React.useEffect(() => {
    if (!open) return

    let touchOrigin: { x: number; y: number } | null = null

    const getTargetKind = (target: EventTarget | null): MediaScrollTarget => {
      if (!(target instanceof Element)) return "other"
      if (target.closest("input[type='range']")) return "range"
      if (target.closest("video")) return "video"
      if (target.closest("input, textarea, select, [contenteditable='true']")) {
        return "text-input"
      }
      if (target.closest("button, a[href]")) return "activation"
      return "other"
    }

    const onWheel = (event: WheelEvent) => {
      if (shouldPreventMediaWheel(event.ctrlKey)) event.preventDefault()
    }

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        touchOrigin = null
        return
      }
      touchOrigin = {
        x: event.touches[0].clientX,
        y: event.touches[0].clientY,
      }
    }

    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0]
      const deltaX = touch && touchOrigin ? touch.clientX - touchOrigin.x : 0
      const deltaY = touch && touchOrigin ? touch.clientY - touchOrigin.y : 0
      if (
        shouldPreventMediaTouchMove({
          touchCount: event.touches.length,
          target: getTargetKind(event.target),
          deltaX,
          deltaY,
        })
      ) {
        event.preventDefault()
      }
    }

    const preventPageKeyScroll = (event: KeyboardEvent) => {
      if (shouldPreventMediaKeyScroll(event.key, getTargetKind(event.target))) {
        event.preventDefault()
      }
    }

    document.addEventListener("wheel", onWheel, { passive: false })
    document.addEventListener("touchstart", onTouchStart, { passive: true })
    document.addEventListener("touchmove", onTouchMove, { passive: false })
    // Base UI stops composite arrow keys at the popup, so capture them before
    // they can trigger viewport scrolling behind the fixed media viewer.
    document.addEventListener("keydown", preventPageKeyScroll, true)
    return () => {
      document.removeEventListener("wheel", onWheel)
      document.removeEventListener("touchstart", onTouchStart)
      document.removeEventListener("touchmove", onTouchMove)
      document.removeEventListener("keydown", preventPageKeyScroll, true)
    }
  }, [open])

  return <Dialog open={open} modal="trap-focus" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        // Keep the overlay to a simple opacity layer. Animating backdrop-filter
        // forces the browser to re-rasterize every image behind every dialog,
        // which shows up as a full-page image flicker when the dialog closes.
        "fixed inset-0 isolate z-50 touch-none overscroll-contain bg-black/10 duration-150 ease-[cubic-bezier(0.25,1,0.5,1)] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-200 ease-[cubic-bezier(0.25,1,0.5,1)] outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:animate-none",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-2 right-2"
                size="icon-sm"
              />
            }
          >
            <XIcon
            />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  MediaDialog,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
