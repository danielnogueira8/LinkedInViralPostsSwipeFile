"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Coins } from "lucide-react";
import { cn } from "@/lib/utils";

// The monthly chat-credits pill (stacked-coins icon), shown in the sidebar
// footer and the mobile top bar. Displays `used/limit` for the current
// workspace's calendar-month chat messages — the SAME count claim_chat_turn
// enforces against, so the number that shows is the number that bites.
//
// Fetches from /api/usage after mount so dashboard navigation does not block on
// usage accounting. The pill renders in two places at once (sidebar + mobile
// bar), so the request is deduped per Workspace and the result cached — the
// second instance reuses the first instance's fetch instead of firing its own.
// The chat workspace dispatches "swipein:usage-changed" after a turn so the
// count stays live without polling.

type UsageData = {
  used: number;
  limit: number;
  boundBy: "messages" | "cost";
};

const usageCache = new Map<string, UsageData>();
const usageInflight = new Map<string, Promise<UsageData | null>>();

export function fetchUsageForWorkspace(workspaceId: string): Promise<UsageData | null> {
  const cached = usageCache.get(workspaceId);
  if (cached) return Promise.resolve(cached);

  const inflight = usageInflight.get(workspaceId);
  if (inflight) return inflight;

  const request = fetch("/api/usage")
    .then((res) => res.json())
    .then((data): UsageData | null =>
      data?.ok && typeof data.used === "number"
        ? {
            used: data.used,
            limit: typeof data.limit === "number" ? data.limit : 0,
            boundBy: data.boundBy === "cost" ? "cost" : "messages",
          }
        : null,
    )
    .catch(() => null)
    .then((result) => {
      usageInflight.delete(workspaceId);
      if (result) usageCache.set(workspaceId, result);
      return result;
    });
  usageInflight.set(workspaceId, request);
  return request;
}

export function UsagePill({
  workspaceId,
  initialUsed,
  limit,
  initialBoundBy = "messages",
}: {
  workspaceId: string;
  initialUsed?: number;
  limit?: number;
  initialBoundBy?: "messages" | "cost";
}) {
  const cached = usageCache.get(workspaceId);
  const [used, setUsed] = useState(cached?.used ?? initialUsed ?? 0);
  const [resolvedLimit, setResolvedLimit] = useState(cached?.limit ?? limit ?? 0);
  const [ready, setReady] = useState(
    cached !== undefined ||
      (typeof initialUsed === "number" && typeof limit === "number"),
  );
  // Which ceiling is currently driving the number — the message count or the
  // monthly $ cost cap. When it's "cost", the displayed credits reflect spend
  // projected onto the message scale, so the pill stays honest for heavy users
  // who hit the cost cap before the message cap.
  const [boundBy, setBoundBy] = useState<"messages" | "cost">(
    cached?.boundBy ?? initialBoundBy,
  );

  const refetch = useCallback(async () => {
    const data = await fetchUsageForWorkspace(workspaceId);
    if (data) {
      setUsed(data.used);
      setResolvedLimit(data.limit);
      setBoundBy(data.boundBy);
      setReady(true);
    }
    // Best-effort — leave the last known value on a transient failure.
  }, [workspaceId]);

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
      ? "text-state-danger"
      : pct >= 0.8
        ? "text-state-warning"
        : "text-muted-foreground";

  const tooltip =
    boundBy === "cost"
      ? `You're near this month's chat limit (resets on the 1st). Based on usage so far, roughly ${Math.max(0, resolvedLimit - used).toLocaleString()} messages left.`
      : ready
        ? `${used.toLocaleString()} of ${resolvedLimit.toLocaleString()} monthly chat credits used (resets on the 1st)`
        : "Loading monthly chat credits";

  return (
    <Link
      href="/dashboard/settings"
      className="flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent/60"
      title={`${tooltip}. Open settings to manage your workspace.`}
      aria-label={
        ready
          ? `${used} of ${resolvedLimit} monthly chat credits used. Open settings.`
          : "Loading monthly chat credits. Open settings."
      }
    >
      <Coins className={cn("h-3.5 w-3.5 shrink-0", tone)} aria-hidden />
      <span className={cn("tabular-nums", tone)}>
        {ready ? `${used.toLocaleString()}/${resolvedLimit.toLocaleString()}` : "…"}
      </span>
      <span className="text-muted-foreground/70">chat credits</span>
    </Link>
  );
}
