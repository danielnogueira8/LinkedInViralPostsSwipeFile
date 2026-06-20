"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";

// "Model this post" — stashes the post server-side (resolving full text, and
// for bookmarks scraping it if the snippet is all we had) and opens the chat
// with ?model=<id>, where it becomes a source-post chip + a modeling prompt.
//
// Shared by the swipe PostCard and the bookmarks SavedPostCard so the behavior
// (loading state, error handling, navigation) stays identical across both.
export function ModelThisPostButton({
  source,
  postId,
}: {
  source: "swipe" | "bookmark";
  postId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/model-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, postId }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Couldn't open this post in chat");
      if (data.partial) {
        toast.message("Only a partial of this post was captured", {
          description: "The full version may be longer — modeling off what we have.",
        });
      }
      router.push(`/dashboard?model=${encodeURIComponent(data.id)}`);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false); // keep the button usable on failure (no navigation happened)
    }
    // On success we navigate away, so we deliberately leave busy=true to avoid a
    // flash of the idle state during the route transition.
  };

  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={busy}>
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <MessageSquare className="h-3.5 w-3.5" />
      )}
      {busy ? "Opening…" : "Model this post"}
    </Button>
  );
}
