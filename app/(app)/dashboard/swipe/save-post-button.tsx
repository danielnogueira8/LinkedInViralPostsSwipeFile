"use client";

import { useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// "no niche" is encoded as a literal sentinel rather than empty string —
// Radix's Select disallows empty-string values on SelectItem.
const NO_NICHE = "__none";

// Post-type selector. "auto" lets the server classify from the scraped text
// (lib/post-type.ts) — the same regex sweep the daily pipeline uses — so the
// common case needs no input. The explicit values force the tag.
const AUTO_TYPE = "__auto";

export type CategoryOption = { id: string; label: string };

// Small banner-style button that sits in the Swipe File toolbar when the
// user is in "Saved" mode. Opens a modal with URL + optional niche + note.
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
  const [note, setNote] = useState("");
  const [category, setCategory] = useState<string>(NO_NICHE);
  const [postType, setPostType] = useState<string>(AUTO_TYPE);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    try {
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
            note: note.trim() || undefined,
            category: category === NO_NICHE ? undefined : category,
            postType: postType === AUTO_TYPE ? undefined : postType,
          }),
        },
      );
      if (!data.ok) throw new Error(data.error);
      toast.success(data.alreadySaved ? "Already in your saved posts" : "Saved");
      setUrl("");
      setNote("");
      setCategory(NO_NICHE);
      setPostType(AUTO_TYPE);
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
              <label className="text-xs font-medium text-muted-foreground" htmlFor="saved-niche">
                Niche <span className="opacity-60">(optional)</span>
              </label>
              <Select
                value={category}
                onValueChange={(v) => setCategory(v ?? NO_NICHE)}
                disabled={busy}
              >
                <SelectTrigger id="saved-niche">
                  <SelectValue placeholder="No niche" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_NICHE}>No niche</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="saved-type">
                Post type
              </label>
              <Select
                value={postType}
                onValueChange={(v) => setPostType(v ?? AUTO_TYPE)}
                disabled={busy}
              >
                <SelectTrigger id="saved-type">
                  <SelectValue placeholder="Auto-detect" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO_TYPE}>Auto-detect</SelectItem>
                  <SelectItem value="regular">Regular post</SelectItem>
                  <SelectItem value="lead_magnet">Lead magnet</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="saved-note">
                Note <span className="opacity-60">(optional)</span>
              </label>
              <Textarea
                id="saved-note"
                placeholder="Why are you saving this?"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={busy}
                rows={3}
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
