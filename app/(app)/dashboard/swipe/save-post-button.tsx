"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bookmark, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { fetchJson, AuthExpiredError } from "@/lib/api-fetch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  CategoryPicker,
  useCreateCategory,
  type CategoryOption,
  type CategoryPickerHandle,
} from "@/components/category-picker";

export type { CategoryOption };

// Small banner-style button that sits in the Swipe File toolbar when the
// user is in "Saved" mode. Opens a modal with URL + optional niche.
// The API does idempotent upsert by activity_id, so re-saving an existing
// post is a no-op rather than an error.
export function SavePostButton({
  categories,
  shareId,
}: {
  categories: CategoryOption[];
  // When set, the save POSTs against ?share=<id> so the new bookmark
  // lands in someone else's shared library (attributed via
  // created_by_user_id server-side).
  shareId?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  // "" = uncategorized; a non-empty id is a curated or custom category.
  const [categoryId, setCategoryId] = useState<string>("");
  const { options, createCategory } = useCreateCategory(categories, setCategoryId);
  const categoryPicker = useRef<CategoryPickerHandle | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    try {
      // Flush a typed-but-uncommitted custom category first, so a user who types
      // a name and clicks Save (without pressing Enter / the ✓) doesn't silently
      // lose it. flush returns the id to send, since setCategoryId hasn't applied
      // to `categoryId` yet this tick.
      const flush = (await categoryPicker.current?.flushPending()) ?? {
        ok: true as const,
        categoryId: categoryId || null,
      };
      if (!flush.ok) {
        setBusy(false);
        return; // create failed; its own toast already fired, keep dialog open
      }
      const endpoint = shareId
        ? `/api/saved-posts?share=${encodeURIComponent(shareId)}`
        : "/api/saved-posts";
      const data = await fetchJson<{ ok: boolean; error?: string; alreadySaved?: boolean }>(
        endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: url.trim(),
            category: flush.categoryId ?? undefined,
            // post_type is always auto-classified server-side from the scraped
            // text (lib/post-type.ts) — the detection is reliable enough that
            // we don't surface a manual override.
          }),
        },
      );
      if (!data.ok) throw new Error(data.error);
      toast.success(data.alreadySaved ? "Already in your saved posts" : "Saved");
      setUrl("");
      setCategoryId("");
      setOpen(false);
      router.refresh();
    } catch (e) {
      if (e instanceof AuthExpiredError) {
        // Logged out mid-session — keep the dialog open (so the pasted URL
        // isn't lost) and offer a one-click reload to re-auth.
        toast.error(e.message, {
          action: { label: "Reload", onClick: () => window.location.reload() },
        });
      } else {
        toast.error((e as Error).message);
      }
    }
    setBusy(false);
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5"
      >
        <Plus className="h-3.5 w-3.5" /> Save a post
      </Button>

      <Dialog open={open} onOpenChange={(v) => { if (!busy) setOpen(v); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Bookmark className="h-4 w-4 text-primary" /> Save a LinkedIn post
            </DialogTitle>
            <DialogDescription>
              Paste any LinkedIn post URL. We&rsquo;ll keep it in your bookmarks with the
              author and a preview — no scraping, so engagement numbers won&rsquo;t be tracked.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={submit} className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="saved-url">
                LinkedIn URL
              </label>
              <Input
                id="saved-url"
                type="url"
                required
                autoFocus
                placeholder="https://www.linkedin.com/posts/..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={busy}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Niche <span className="opacity-60">(optional)</span>
              </label>
              <CategoryPicker
                value={categoryId}
                onChange={setCategoryId}
                options={options}
                onCreate={createCategory}
                commitRef={categoryPicker}
                uncategorizedLabel="No niche"
              />
            </div>
            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setOpen(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy || !url.trim()}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bookmark className="h-3.5 w-3.5" />}
                {busy ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
