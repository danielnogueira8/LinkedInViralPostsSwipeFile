"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { Check, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { fetchJson } from "@/lib/api-fetch";
import {
  CategoryPicker,
  useCreateCategory,
  type CategoryOption,
  type CategoryPickerHandle,
} from "@/components/category-picker";

export type { CategoryOption };

export function AddAccountButton({
  categories,
  manualCount,
  manualLimit,
  label = "Paste LinkedIn URL",
}: {
  categories: CategoryOption[];
  manualCount: number;
  manualLimit: number;
  label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [profileUrl, setProfileUrl] = useState("");
  const [categoryId, setCategoryId] = useState<string>("");
  const { options, createCategory } = useCreateCategory(categories, setCategoryId);
  const categoryPicker = useRef<CategoryPickerHandle | null>(null);
  const atLimit = manualCount >= manualLimit;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      // Flush a typed-but-uncommitted custom category first, so a user who types
      // a name and clicks "Add creator" (without pressing Enter / the ✓) doesn't
      // silently lose it. flush returns the id to send, since setCategoryId
      // hasn't applied to `categoryId` yet this tick.
      const flush = (await categoryPicker.current?.flushPending()) ?? {
        ok: true as const,
        categoryId: categoryId || null,
      };
      if (!flush.ok) {
        setBusy(false);
        return; // create failed; its own toast already fired, keep dialog open
      }
      const effectiveCategoryId = flush.categoryId;

      // Not via fetchJson: a 409 here carries a meaningful { code: "duplicate" }
      // body the client must inspect, so we read the JSON regardless of status.
      // We still guard against a non-JSON (e.g. 5xx HTML) body so the toast
      // shows a clean message instead of "Unexpected token <".
      const res = await fetch("/api/accounts/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile_url: profileUrl,
          category_id: effectiveCategoryId,
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
      // Two success shapes, driven by whether the free profile-metadata fetch
      // resolved. When it did, name it and reassure that posts are coming; when
      // LinkedIn blocked/timed out the preview, add anyway and say details will
      // fill in on the next scrape.
      if (data.meta_resolved) {
        toast.success(`Added ${data.account.name}`, {
          description: "We'll start pulling posts from this creator.",
        });
      } else {
        toast.success("Added from URL. Profile details will update later.");
      }
      setProfileUrl(""); setCategoryId("");
      setOpen(false);
      router.refresh();
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  }

  return (
    <>
      <div className="flex flex-col items-end gap-1">
        <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={atLimit}>
          <Plus className="h-4 w-4" /> {label}
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
            <DialogTitle>Add creator</DialogTitle>
            <DialogDescription>
              Paste a LinkedIn profile URL and we&apos;ll start pulling their strongest posts into your Swipe File.{" "}
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
              <Label>Category</Label>
              <CategoryPicker
                value={categoryId}
                onChange={setCategoryId}
                options={options}
                onCreate={createCategory}
                commitRef={categoryPicker}
              />
              <p className="text-[11px] text-muted-foreground">
                Pick a bucket or create your own. Leave blank to add uncategorized (you can fix it later).
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
              <Button type="submit" disabled={busy || !profileUrl}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {busy ? "Fetching profile…" : "Add creator"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
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
        className="grid size-11 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-destructive disabled:opacity-50"
        aria-label={`Delete ${name}`}
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

// Edit a manually-added creator's name and category. Only rendered for manual
// creators (the route also enforces this). On save it calls back into the
// parent (creator picker) so the card updates without a full reload.
export function EditAccountButton({
  id,
  name: initialName,
  categoryId: initialCategoryId,
  categories,
  onSaved,
}: {
  id: string;
  name: string;
  categoryId: string | null;
  categories: CategoryOption[];
  // Called with the new values after a successful save so the parent can patch
  // its local creator list optimistically (instead of a blocking refresh).
  onSaved?: (next: { name: string; categoryId: string | null }) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(initialName);
  const [categoryId, setCategoryId] = useState<string>(initialCategoryId ?? "");
  const { options, createCategory } = useCreateCategory(categories, setCategoryId);
  const categoryPicker = useRef<CategoryPickerHandle | null>(null);
  // True while the user has typed (but not yet committed) a new category name.
  // Counts as a pending change so Save isn't disabled — the submit handler
  // flushes the draft before sending.
  const [hasPendingCategory, setHasPendingCategory] = useState(false);

  // Reset the form to the current values each time the dialog opens, so a
  // cancelled edit doesn't leave stale draft state on the next open.
  function openDialog() {
    setName(initialName);
    setCategoryId(initialCategoryId ?? "");
    setHasPendingCategory(false);
    setOpen(true);
  }

  const dirty =
    name.trim() !== initialName.trim() ||
    (categoryId || null) !== (initialCategoryId ?? null) ||
    hasPendingCategory;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      // Flush a typed-but-uncommitted custom category first (e.g. user typed
      // "UGC" and clicked Save without pressing Enter / the ✓). Use the returned
      // id since setCategoryId hasn't applied to `categoryId` yet this tick.
      const flush = (await categoryPicker.current?.flushPending()) ?? {
        ok: true as const,
        categoryId: categoryId || null,
      };
      if (!flush.ok) {
        setBusy(false);
        return; // create failed; its toast already fired, keep dialog open
      }
      const data = await fetchJson<{
        ok: boolean;
        error?: string;
        account: { id: string; name: string; category_id: string | null };
      }>("/api/accounts/manual", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, name: trimmed, category_id: flush.categoryId }),
      });
      if (!data.ok) throw new Error(data.error);
      toast.success(`Updated ${data.account.name}`);
      setOpen(false);
      onSaved?.({ name: data.account.name, categoryId: data.account.category_id });
      // Reconcile category rail counts etc. that the optimistic patch can't.
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
    setBusy(false);
  }

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="grid size-11 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label={`Edit ${initialName}`}
        title="Edit creator"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit creator</DialogTitle>
            <DialogDescription>
              Update the name and category for this creator.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor={`edit-name-${id}`}>Name</Label>
              <Input
                id={`edit-name-${id}`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label>Category</Label>
              <CategoryPicker
                value={categoryId}
                onChange={setCategoryId}
                options={options}
                onCreate={createCategory}
                commitRef={categoryPicker}
                onPendingChange={setHasPendingCategory}
              />
              <p className="text-[11px] text-muted-foreground">
                Pick a bucket or create your own. Leave blank for uncategorized.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
              <Button type="submit" disabled={busy || !name.trim() || !dirty}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
