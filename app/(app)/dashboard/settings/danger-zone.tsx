"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useClerk } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

// Self-serve GDPR erasure — the UI half of POST /api/account/delete. A typed
// "DELETE" confirmation gates it (matches the API's { confirm: "DELETE" }). On
// success the workspace + its Clerk org are gone, so we sign the user out.
export function DangerZone() {
  const router = useRouter();
  const { signOut } = useClerk();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleDelete() {
    setBusy(true);
    try {
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      const data = await res.json().catch(() => null);
      if (!data?.ok) {
        throw new Error(data?.error || `Request failed (${res.status})`);
      }
      toast.success("Your data has been deleted. Signing you out…");
      // Workspace + org are gone; end the session and return to the marketing site.
      await signOut(() => router.push("/"));
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/[0.03] p-5">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
        <div className="flex-1">
          <h2 className="text-base font-semibold text-foreground">Delete my data</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Permanently delete this workspace and everything in it — chats,
            drafts, saved posts, your voice profile, custom skills, tracked
            creators, and settings. This cannot be undone.
          </p>
          <Button
            variant="destructive"
            size="sm"
            className="mt-3"
            onClick={() => {
              setConfirm("");
              setOpen(true);
            }}
          >
            Delete my data
          </Button>
        </div>
      </div>

      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete everything in this workspace?</DialogTitle>
            <DialogDescription>
              This permanently erases all of your data and closes the workspace.
              It can&apos;t be undone. Type{" "}
              <span className="font-semibold text-foreground">DELETE</span> to
              confirm.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="DELETE"
            aria-label="Type DELETE to confirm"
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={busy || confirm !== "DELETE"}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Permanently delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
