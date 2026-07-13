"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"
import {
  type DialogScrollTarget,
  dialogScrollDirection,
  shouldPreventDialogKeyScroll,
  shouldPreventDialogTouchMove,
} from "@/lib/dialog-scroll-guard"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

type DialogProps = Omit<DialogPrimitive.Root.Props, "modal">

// Base UI's full modal mode mutates document overflow and restores it before
// the exit animation finishes, which re-renders the page behind the dialog.
// Keep modality stable at this boundary: Base UI owns focus management, while
// the semantic popup and backdrop contain pointer, touch, wheel, and keys.
function Dialog({ ...props }: DialogProps) {
  return (
    <DialogPrimitive.Root data-slot="dialog" modal="trap-focus" {...props} />
  )
}

function MediaDialog({
  open,
  ...props
}: Omit<DialogPrimitive.Root.Props, "modal" | "open"> & { open: boolean }) {
  return <Dialog open={open} {...props} />
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
        // Base UI waits for the longer popup exit before unmounting the portal,
        // so retain the overlay's faded state instead of flashing back to opacity 1.
        "fixed inset-0 isolate z-50 touch-none overscroll-contain bg-black/10 duration-150 ease-[cubic-bezier(0.25,1,0.5,1)] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 data-closed:fill-mode-forwards motion-reduce:animate-none",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  ref,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
}) {
  const [popupElement, setPopupElement] = React.useState<HTMLDivElement | null>(
    null
  )
  const mergedRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      setPopupElement(node)
      if (typeof ref === "function") ref(node)
      else if (ref) ref.current = node
    },
    [ref]
  )

  React.useEffect(() => {
    const popup = popupElement
    if (!popup) return

    const ownerDocument = popup.ownerDocument
    const isTopmostDialog = () => {
      const openDialogs = ownerDocument.querySelectorAll<HTMLElement>(
        '[data-slot="dialog-content"][data-open], [data-slot="dialog-content"][data-closed]'
      )
      return openDialogs.item(openDialogs.length - 1) === popup
    }

    const preventBackgroundKeyScroll = (event: KeyboardEvent) => {
      if (!isTopmostDialog()) return

      const target = getDialogScrollTarget(event.target)
      const canScrollInsideDialog = popup.contains(event.target as Node)
        ? canScrollWithin(
            event.target,
            popup,
            dialogScrollDirection(event.key, event.shiftKey)
          )
        : false

      if (
        shouldPreventDialogKeyScroll({
          canScrollInsideDialog,
          key: event.key,
          target,
        })
      ) {
        event.preventDefault()
      }
    }

    const preventBackgroundWheel = (event: WheelEvent) => {
      if (!isTopmostDialog() || event.ctrlKey) return
      const canScrollInsideDialog =
        popup.contains(event.target as Node) &&
        canScrollWithin(event.target, popup, Math.sign(event.deltaY))
      if (!canScrollInsideDialog) event.preventDefault()
    }

    let touchOrigin: { x: number; y: number } | null = null
    const rememberTouchOrigin = (event: TouchEvent) => {
      const touch = event.touches[0]
      touchOrigin =
        event.touches.length === 1 && touch
          ? { x: touch.clientX, y: touch.clientY }
          : null
    }
    const preventBackgroundTouchMove = (event: TouchEvent) => {
      if (!isTopmostDialog()) return

      const touch = event.touches[0]
      const deltaX = touch && touchOrigin ? touch.clientX - touchOrigin.x : 0
      const deltaY = touch && touchOrigin ? touch.clientY - touchOrigin.y : 0
      const canScrollInsideDialog =
        popup.contains(event.target as Node) &&
        canScrollWithin(event.target, popup, -Math.sign(deltaY))

      if (
        shouldPreventDialogTouchMove({
          canScrollInsideDialog,
          deltaX,
          deltaY,
          target: getDialogScrollTarget(event.target),
          touchCount: event.touches.length,
        })
      ) {
        event.preventDefault()
      }
      rememberTouchOrigin(event)
    }

    // Capture before Base UI's composite-key handling. This keeps page-scroll
    // inputs in the topmost dialog without changing document presentation.
    ownerDocument.addEventListener("keydown", preventBackgroundKeyScroll, true)
    ownerDocument.addEventListener("wheel", preventBackgroundWheel, {
      capture: true,
      passive: false,
    })
    ownerDocument.addEventListener("touchstart", rememberTouchOrigin, {
      capture: true,
      passive: true,
    })
    ownerDocument.addEventListener("touchmove", preventBackgroundTouchMove, {
      capture: true,
      passive: false,
    })
    return () => {
      ownerDocument.removeEventListener(
        "keydown",
        preventBackgroundKeyScroll,
        true
      )
      ownerDocument.removeEventListener("wheel", preventBackgroundWheel, true)
      ownerDocument.removeEventListener("touchstart", rememberTouchOrigin, true)
      ownerDocument.removeEventListener(
        "touchmove",
        preventBackgroundTouchMove,
        true
      )
    }
  }, [popupElement])

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        ref={mergedRef}
        data-slot="dialog-content"
        aria-modal="true"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto overscroll-contain rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-200 ease-[cubic-bezier(0.25,1,0.5,1)] outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-closed:fill-mode-forwards motion-reduce:animate-none",
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

function getDialogScrollTarget(target: EventTarget | null): DialogScrollTarget {
  if (!(target instanceof Element)) return "other"
  if (target.closest("input[type='range']")) return "range"
  if (target.closest("audio, video")) return "media"
  if (target.closest("input, textarea, select, [contenteditable='true']")) {
    return "text-input"
  }
  if (target.closest("button, a[href]")) return "activation"
  return "other"
}

function canScrollWithin(
  target: EventTarget | null,
  boundary: HTMLElement,
  direction: number
) {
  if (direction === 0 || !(target instanceof Element)) return false

  let element: Element | null = target
  while (element && boundary.contains(element)) {
    if (element instanceof HTMLElement) {
      const overflowY = getComputedStyle(element).overflowY
      const isScrollable =
        /(auto|scroll)/.test(overflowY) &&
        element.scrollHeight > element.clientHeight + 1

      if (isScrollable) {
        if (direction < 0 && element.scrollTop > 0) return true
        if (
          direction > 0 &&
          element.scrollTop + element.clientHeight < element.scrollHeight - 1
        ) {
          return true
        }
      }
    }
    if (element === boundary) break
    element = element.parentElement
  }
  return false
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
