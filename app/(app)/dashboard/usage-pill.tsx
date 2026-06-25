"use client";

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

// The 🪙 monthly-message credits pill, shown in the sidebar footer. Displays
// `used/limit` for the current workspace's calendar-month chat messages — the
// SAME count claim_chat_turn enforces against, so the number that shows is the
// number that bites.
//
// Seeded with a server-computed initial value (no loading flash), then refetches
// from /api/usage when a chat turn completes. The chat workspace dispatches a
// "swipein:usage-changed" window event after a turn so the count stays live
// without polling.
export function UsagePill({
  initialUsed,
  limit,
}: {
  initialUsed: number;
  limit: number;
}) {
  const [used, setUsed] = useState(initialUsed);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/usage");
      const data = await res.json();
      if (data?.ok && typeof data.used === "number") setUsed(data.used);
    } catch {
      // Best-effort — leave the last known value on a transient failure.
    }
  }, []);

  useEffect(() => {
    const onChanged = () => void refetch();
    window.addEventListener("swipein:usage-changed", onChanged);
    return () => window.removeEventListener("swipein:usage-changed", onChanged);
  }, [refetch]);

  const pct = limit > 0 ? used / limit : 0;
  // Soft warning states: muted normally, amber as the allowance runs low, red
  // when spent. Doubles as an at-a-glance "you're near the cap" cue.
  const tone =
    pct >= 1
      ? "text-red-600 dark:text-red-400"
      : pct >= 0.8
        ? "text-amber-600 dark:text-amber-500"
        : "text-muted-foreground";

  return (
    <div
      className="flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium"
      title={`${used.toLocaleString()} of ${limit.toLocaleString()} monthly chat messages used (resets on the 1st)`}
      aria-label={`${used} of ${limit} monthly chat messages used`}
    >
      <span aria-hidden>🪙</span>
      <span className={cn("tabular-nums", tone)}>
        {used.toLocaleString()}/{limit.toLocaleString()}
      </span>
      <span className="text-muted-foreground/70">used</span>
    </div>
  );
}
