"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Sparkles, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

// "Generate this week's batch" — the on-demand trigger for the weekly content
// pipeline. Finds this week's top posts, adapts them into the user's voice, and
// drops them onto this board as review-ready drafts.
//
// v1 is fire-and-forget: the route runs generation in after() and returns
// immediately, so we show a "generating…" state, tell the user it'll appear
// shortly, and refresh the board after a delay to pull in the new drafts. (PR 2
// upgrades this to a real status poll + a settlement toast, no guessing the
// delay.)
const REFRESH_AFTER_MS = 45_000;

export function GenerateBatchButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const generate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/batch/weekly", { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        reason?: string;
        retryAt?: string;
      };
      if (!res.ok || !data.ok) {
        // Cooldown + cost-cap come back as friendly 429s; show the message.
        toast.error(data.error || "Couldn't start your batch. Try again shortly.");
        setBusy(false);
        return;
      }
      toast.success("Generating this week's batch…", {
        description:
          "Finding top posts and drafting them in your voice. New drafts will appear here in a minute.",
      });
      // Pull in the freshly-generated drafts once they've had time to land.
      // Keep the button disabled until then so a double-click can't stack runs
      // (the server cooldown also blocks it, but this avoids the wasted request).
      window.setTimeout(() => {
        router.refresh();
        setBusy(false);
      }, REFRESH_AFTER_MS);
    } catch {
      toast.error("Couldn't start your batch. Try again shortly.");
      setBusy(false);
    }
  };

  return (
    <Button onClick={generate} disabled={busy} className="gap-2">
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Sparkles className="h-4 w-4" />
      )}
      {busy ? "Generating…" : "Generate this week's batch"}
    </Button>
  );
}
