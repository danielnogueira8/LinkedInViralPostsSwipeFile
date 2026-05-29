"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { fetchJson } from "@/lib/api-fetch";

export type CategoryOption = { id: string; label: string };

export function AddAccountButton({
  categories,
  manualCount,
  manualLimit,
}: {
  categories: CategoryOption[];
  manualCount: number;
  manualLimit: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [profileUrl, setProfileUrl] = useState("");
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState<string>("");
  const atLimit = manualCount >= manualLimit;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      // Not via fetchJson: a 409 here carries a meaningful { code: "duplicate" }
      // body the client must inspect, so we read the JSON regardless of status.
      // We still guard against a non-JSON (e.g. 5xx HTML) body so the toast
      // shows a clean message instead of "Unexpected token <".
      const res = await fetch("/api/accounts/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile_url: profileUrl,
          name,
          category_id: categoryId || null,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!data) throw new Error(`Request failed (${res.status})`);
      if (!data.ok) {
        // A duplicate isn't an error the user caused by doing something wrong —
        // they just already track this creator. Show it as a neutral notice and
        // keep the dialog open so they can correct the URL, rather than a red
        // failure toast that reads like the add broke.
        if (data.code === "duplicate") {
          toast(data.error);
          setBusy(false);
          return;
        }
        throw new Error(data.error);
      }
      toast.success(`Added ${data.account.name}`);
      setProfileUrl(""); setName(""); setCategoryId("");
      setOpen(false);
      router.refresh();
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  }

  return (
    <>
      <div className="flex flex-col items-end gap-1">
        <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={atLimit}>
          <Plus className="h-4 w-4" /> Add creator
        </Button>
        <span className={cn(
          "text-xs tabular-nums",
          manualCount >= manualLimit ? "text-destructive font-medium" : "text-muted-foreground",
        )}>
          {manualCount}/{manualLimit} custom creators
        </span>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add creator manually</DialogTitle>
            <DialogDescription>
              Adds a creator outside of the Google Sheet. Sheet sync won&apos;t overwrite or remove it.{" "}
              <span className={cn(manualCount >= manualLimit && "text-destructive font-medium")}>
                {manualCount}/{manualLimit} custom creators used.
              </span>
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="manual-url">LinkedIn profile URL</Label>
              <Input
                id="manual-url"
                type="url"
                placeholder="https://www.linkedin.com/in/zach-schieffer"
                value={profileUrl}
                onChange={(e) => setProfileUrl(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="manual-name">Name</Label>
              <Input
                id="manual-name"
                placeholder="Zach Schieffer"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label>Category</Label>
              <CategoryPicker
                value={categoryId}
                onChange={setCategoryId}
                options={categories}
              />
              <p className="text-[11px] text-muted-foreground">
                Pick the canonical bucket. Leave blank to add uncategorized (you can fix it later).
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
              <Button type="submit" disabled={busy || !profileUrl || !name}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Add creator
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CategoryPicker({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: CategoryOption[];
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        type="button"
        onClick={() => onChange("")}
        className={cn(
          "px-2.5 py-1 rounded-full border text-xs transition-colors",
          !value
            ? "bg-foreground text-background border-foreground"
            : "bg-background text-muted-foreground border-border hover:text-foreground hover:bg-accent/60",
        )}
      >
        Uncategorized
      </button>
      {options.map((c) => {
        const active = value === c.id;
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onChange(c.id)}
            className={cn(
              "px-2.5 py-1 rounded-full border text-xs transition-colors",
              active
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-muted-foreground border-border hover:text-foreground hover:bg-accent/60",
            )}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

export function DeleteAccountButton({
  id,
  name,
  onOptimisticDelete,
  onRollback,
}: {
  id: string;
  name: string;
  // Optimistic removal: when the parent (creator picker) holds the list, it
  // passes these so the row drops instantly. onOptimisticDelete fires before
  // the request; onRollback restores the row if the DELETE fails. When both
  // are absent, del() falls back to the blocking router.refresh() path.
  onOptimisticDelete?: () => void;
  onRollback?: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const optimistic = !!onOptimisticDelete;

  async function del() {
    // Optimistic path: drop the row now, fire DELETE in the background.
    if (optimistic) {
      onOptimisticDelete!();
      setConfirmOpen(false);
      try {
        const data = await fetchJson<{ ok: boolean; error?: string }>(
          `/api/accounts/manual?id=${encodeURIComponent(id)}`,
          { method: "DELETE" },
        );
        if (!data.ok) throw new Error(data.error);
        toast.success(`Deleted ${name}`);
      } catch (e) {
        onRollback?.(); // restore the row
        toast.error((e as Error).message);
      }
      return;
    }

    // Blocking fallback.
    setBusy(true);
    try {
      const data = await fetchJson<{ ok: boolean; error?: string }>(
        `/api/accounts/manual?id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!data.ok) throw new Error(data.error);
      toast.success(`Deleted ${name}`);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
      throw e; // bubble so the confirm dialog keeps itself open for retry
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        disabled={busy}
        className="text-muted-foreground hover:text-destructive rounded-md p-1 hover:bg-muted transition-colors disabled:opacity-50"
        title="Delete account"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
      </button>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete ${name}?`}
        description="This removes the creator and all its posts from your workspace. You can re-add them later by URL."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={del}
      />
    </>
  );
}
