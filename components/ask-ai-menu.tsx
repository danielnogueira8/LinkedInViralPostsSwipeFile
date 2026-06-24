"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Sparkles,
  Loader2,
  MessageSquare,
  ScanText,
  CopyPlus,
  Lightbulb,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  POST_INTENTS,
  type PostIntent,
  type PostIntentKey,
} from "@/lib/post-intents";

// Contextual AI actions on a post card. Stashes the post server-side (resolving
// full text — and for bookmarks, scraping it if only a snippet was saved) via
// /api/model-source, then opens the chat at /dashboard?model=<id>&intent=<key>
// where the chosen intent's prompt is prefilled.
//
// Replaces the single "Model this post" button with a menu so a post becomes a
// launchpad for several agent actions (model after it, break down its hook,
// draft variations, analyze why it worked). The menu pattern mirrors
// BookmarkButton's (relative wrapper + full-screen click-catcher + absolute
// menu) so it feels native and needs no popover dependency.

const INTENT_ICONS: Record<PostIntent["icon"], LucideIcon> = {
  "message-square": MessageSquare,
  "scan-text": ScanText,
  "copy-plus": CopyPlus,
  lightbulb: Lightbulb,
};

// Order the menu intentionally: model (the primary action) first, then the
// analysis/derivation actions.
const INTENT_ORDER: PostIntentKey[] = [
  "model",
  "variations",
  "breakdown",
  "why",
];

export function AskAiMenu({
  source,
  postId,
}: {
  source: "swipe" | "bookmark";
  postId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // The intent currently being launched (shows a spinner on that row); also
  // disables the whole menu so a second click can't fire a parallel stash.
  const [busyKey, setBusyKey] = useState<PostIntentKey | null>(null);

  const launch = async (intent: PostIntent) => {
    if (busyKey) return;
    setBusyKey(intent.key);
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
        `/dashboard?model=${encodeURIComponent(data.id)}&intent=${intent.key}`,
      );
      // On success we navigate away; leave busyKey set to avoid a flash of the
      // idle menu during the route transition.
    } catch (e) {
      toast.error((e as Error).message);
      setBusyKey(null);
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen((o) => !o)}
        disabled={!!busyKey}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {busyKey ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Sparkles className="h-3.5 w-3.5" />
        )}
        {busyKey ? "Opening…" : "Ask AI"}
      </Button>

      {open && !busyKey && (
        <>
          {/* Full-screen catcher closes the menu on any outside click. */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div
            role="menu"
            className="absolute left-0 top-full z-50 mt-1 min-w-56 rounded-lg border border-border/60 bg-card shadow-soft-lg py-1"
          >
            <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Do something with this post
            </div>
            {INTENT_ORDER.map((key) => {
              const intent = POST_INTENTS[key];
              const Icon = INTENT_ICONS[intent.icon];
              return (
                <button
                  key={key}
                  type="button"
                  role="menuitem"
                  onClick={() => launch(intent)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{intent.label}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
