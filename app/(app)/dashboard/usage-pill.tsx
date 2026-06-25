"use client";

import { useCallback, useEffect, useState } from "react";
import { Coins } from "lucide-react";
import { cn } from "@/lib/utils";

// The monthly-message credits pill (stacked-coins icon), shown in the sidebar
// footer. Displays
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
  initialBoundBy = "messages",
}: {
  initialUsed: number;
  limit: number;
  initialBoundBy?: "messages" | "cost";
}) {
  const [used, setUsed] = useState(initialUsed);
  // Which ceiling is currently driving the number — the message count or the
  // monthly $ cost cap. When it's "cost", the displayed credits reflect spend
  // projected onto the message scale, so the pill stays honest for heavy users
  // who hit the cost cap before the message cap.
  const [boundBy, setBoundBy] = useState<"messages" | "cost">(initialBoundBy);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/usage");
      const data = await res.json();
      if (data?.ok && typeof data.used === "number") {
        setUsed(data.used);
        if (data.boundBy === "cost" || data.boundBy === "messages") {
          setBoundBy(data.boundBy);
        }
      }
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

  const tooltip =
    boundBy === "cost"
      ? `You're near this month's chat limit (resets on the 1st). Based on usage so far, roughly ${(limit - used).toLocaleString()} messages left.`
      : `${used.toLocaleString()} of ${limit.toLocaleString()} monthly chat messages used (resets on the 1st)`;

  return (
    <div
      className="flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium"
      title={tooltip}
      aria-label={`${used} of ${limit} monthly chat messages used`}
    >
      <Coins className={cn("h-3.5 w-3.5 shrink-0", tone)} aria-hidden />
      <span className={cn("tabular-nums", tone)}>
        {used.toLocaleString()}/{limit.toLocaleString()}
      </span>
      <span className="text-muted-foreground/70">used</span>
    </div>
  );
}
