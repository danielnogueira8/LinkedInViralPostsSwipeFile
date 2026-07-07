"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MessageSquare, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { POST_INTENTS } from "@/lib/post-intents";

// "Model in Chat" — the single primary action on a post card. Stashes the post
// server-side (resolving full text — and for bookmarks, scraping it if only a
// snippet was saved) via /api/model-source, then opens the chat at
// /dashboard?model=<id>&intent=model with the "model in my voice" prompt
// prefilled and the post woven into the agent envelope.
//
// (Previously a multi-option "Ask AI" menu; collapsed to the one action users
// actually want from a card — take this post into the chat and model it.)
export function AskAiMenu({
  source,
  postId,
}: {
  source: "swipe" | "bookmark";
  postId: string;
}) {
  const router = useRouter();
  // True while stashing + navigating; disables the button so a double-click
  // can't fire a parallel stash.
  const [busy, setBusy] = useState(false);

  const launch = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/model-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, postId }),
      });
      const data = await res.json();
      if (!data.ok)
        throw new Error(data.error || "Couldn't open this post in chat");
      if (data.partial) {
        toast.message("Only a partial of this post was captured", {
          description:
            "The full version may be longer — working off what we have.",
        });
      }
      router.push(
        `/dashboard?model=${encodeURIComponent(data.id)}&intent=${POST_INTENTS.model.key}&handoff=${encodeURIComponent(data.id)}`,
      );
      // On success we navigate away; leave busy set to avoid a flash of the
      // idle button during the route transition.
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={launch}
      disabled={busy}
      title="Take this post into the chat and model it in your voice"
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <MessageSquare className="h-3.5 w-3.5" />
      )}
      {busy ? "Opening…" : "Model with Cowork"}
    </Button>
  );
}
