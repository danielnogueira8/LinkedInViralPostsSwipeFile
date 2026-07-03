"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Send, X } from "lucide-react";
import { fetchJson } from "@/lib/api-fetch";
import { Button } from "@/components/ui/button";

// A one-time (per session) nudge that surfaces on the Posts page when the
// workspace hasn't yet connected a LinkedIn account. Before this, the user
// only discovered the requirement by opening a card, scrolling to the schedule
// row, and finding it gated (or worse — hitting the endpoint's 409). This is
// UX friction #3 from the intuitiveness review: "the connection requirement
// is discovered by failure, not upfront."
//
// Design decisions:
//  • Client-only render, gated by GET /api/integrations/linkedin. Server can't
//    render this without adding a workspace-scoped fetch to the page loader;
//    the flicker of a client mount is fine because the banner ALREADY reflects
//    a "not yet configured" state.
//  • Dismissal persists in sessionStorage — closes for the current browsing
//    session but returns on next open. Deliberate: a permanent dismissal would
//    strand a user who changes their mind after learning what scheduling is.
//  • Hidden ENTIRELY once connected; no "connected" acknowledgement banner —
//    the ScheduleRow's own state is confirmation enough, and quiet is better
//    than a green stripe on every future page load.
//  • Renders NOTHING while the status check is in flight (initial null), to
//    avoid an appear/disappear flash on the common connected path.

const DISMISSED_KEY = "posts:linkedin-nudge:dismissed";

export function ConnectLinkedInBanner() {
  const router = useRouter();
  // null = still loading; true = show; false = hide (connected, dismissed,
  // or the endpoint errored — belt to any transient failure NEVER pushing
  // an in-your-face banner). Lazy-init keeps a prior session dismissal
  // OUT of the effect (setState-in-effect eslint rule).
  const [visible, setVisible] = useState<boolean | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return window.sessionStorage.getItem(DISMISSED_KEY) === "1" ? false : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    // If the lazy-init above already resolved to `false` (session-dismissed),
    // don't fetch — the answer wouldn't change anything user-visible.
    if (visible === false) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchJson<{
          ok: boolean;
          connection: { connected: boolean } | null;
        }>("/api/integrations/linkedin", { cache: "no-store" });
        if (cancelled) return;
        setVisible(!data.connection?.connected);
      } catch {
        // Never nudge on transient failure; the ScheduleRow will 409 clearly
        // if they try to schedule.
        if (!cancelled) setVisible(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Only run the fetch once on mount; visible transitions are user-driven
    // (Connect / dismiss) and shouldn't re-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismiss = () => {
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(DISMISSED_KEY, "1");
      } catch {
        /* ignore */
      }
    }
    setVisible(false);
  };

  if (visible !== true) return null;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/[0.04] px-3.5 py-2.5 text-sm">
      <Send className="h-4 w-4 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <span className="font-medium">Connect LinkedIn</span>
        <span className="ml-1.5 text-muted-foreground">
          to auto-publish drafts on a schedule.
        </span>
      </div>
      <Button
        size="sm"
        variant="default"
        onClick={() => router.push("/dashboard/settings")}
      >
        Connect
      </Button>
      <button
        type="button"
        onClick={dismiss}
        className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
