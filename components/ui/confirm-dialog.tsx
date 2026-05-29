"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

// A small styled replacement for window.confirm(). Use this for destructive
// actions where we want a deliberate "are you sure" beat that visually
// belongs to the app — native confirm() is jarring against our chrome and
// blocks the main thread. For *reversible* actions, prefer an Undo toast
// (sonner action) instead of this.
//
// Pattern: render this once next to the trigger, pass `open` + `onOpenChange`
// from state, and put your action in `onConfirm`. The dialog handles its
// own busy state for the duration of `onConfirm` (Promise) so callers don't
// have to thread a second loading flag through the button.
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "destructive",
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  // "destructive" tints the confirm button red. "default" uses the primary
  // tint — for confirms that aren't destructive (e.g. "Mark as read").
  variant?: "destructive" | "default";
  onConfirm: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  async function handleConfirm() {
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } finally {
      // Keep busy false on failure so the user can retry without remounting.
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // Block accidental close-while-busy; if you cancel the action mid-flight
        // we don't have a way to actually abort it, so the safer thing is to
        // wait.
        if (busy) return;
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={variant === "destructive" ? "destructive" : "default"}
            onClick={handleConfirm}
            disabled={busy}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
