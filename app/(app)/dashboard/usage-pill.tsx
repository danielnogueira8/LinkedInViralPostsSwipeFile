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
// Fetches from /api/usage after mount so dashboard navigation does not block on
// usage accounting. The chat workspace dispatches a "swipein:usage-changed"
// window event after a turn so the count stays live without polling.
export function UsagePill({
  initialUsed,
  limit,
  initialBoundBy = "messages",
}: {
  initialUsed?: number;
  limit?: number;
  initialBoundBy?: "messages" | "cost";
}) {
  const [used, setUsed] = useState(initialUsed ?? 0);
  const [resolvedLimit, setResolvedLimit] = useState(limit ?? 0);
  const [ready, setReady] = useState(
    typeof initialUsed === "number" && typeof limit === "number",
  );
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
        if (typeof data.limit === "number") setResolvedLimit(data.limit);
        if (data.boundBy === "cost" || data.boundBy === "messages") {
          setBoundBy(data.boundBy);
        }
        setReady(true);
      }
    } catch {
      // Best-effort — leave the last known value on a transient failure.
    }
  }, []);

  useEffect(() => {
    const timer = ready ? null : window.setTimeout(() => void refetch(), 0);
    const onChanged = () => void refetch();
    window.addEventListener("swipein:usage-changed", onChanged);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("swipein:usage-changed", onChanged);
    };
  }, [ready, refetch]);

  const pct = resolvedLimit > 0 ? used / resolvedLimit : 0;
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
      ? `You're near this month's chat limit (resets on the 1st). Based on usage so far, roughly ${Math.max(0, resolvedLimit - used).toLocaleString()} messages left.`
      : ready
        ? `${used.toLocaleString()} of ${resolvedLimit.toLocaleString()} monthly chat messages used (resets on the 1st)`
        : "Loading monthly credits";

  return (
    <div
      className="flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium"
      title={tooltip}
      aria-label={
        ready
          ? `${used} of ${resolvedLimit} monthly credits used`
          : "Loading monthly credits"
      }
    >
      <Coins className={cn("h-3.5 w-3.5 shrink-0", tone)} aria-hidden />
      <span className={cn("tabular-nums", tone)}>
        {ready ? `${used.toLocaleString()}/${resolvedLimit.toLocaleString()}` : "…"}
      </span>
      <span className="text-muted-foreground/70">monthly credits used</span>
    </div>
  );
}
