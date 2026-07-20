"use client";

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { cn } from "@/lib/utils";

// "Next drop" countdown for the Swipe File.
//
// The swipe-file refresh is driven by the daily Vercel cron
// (vercel.json → `/api/cron/daily` at `0 0 * * *`), i.e. it fires once a day
// at 00:00 UTC. Because the schedule is a fixed wall-clock time, we can derive
// the next drop entirely on the client — no extra API round-trip — by finding
// the next 00:00 UTC boundary from "now" and ticking down to it.
//
// During the run window (the cron job itself takes a few minutes), we show a
// "Dropping now…" state instead of a negative countdown, then roll over to the
// next day's target on the following tick.

// Cron hour in UTC, mirroring vercel.json's `0 0 * * *`. Kept as a constant so
// that if the schedule ever moves, there's a single place to change it (and a
// reviewer can see it matches the cron without cross-referencing).
const DROP_UTC_HOUR = 0;

// The cron pipeline runs for a while after it fires (scrape + classify). Treat
// the first ~15 min after the boundary as the "dropping" window so the chip
// reads as active rather than flashing a fresh ~24h countdown the instant the
// target passes.
const DROP_WINDOW_MS = 15 * 60 * 1000;

// Next 00:00 UTC strictly after `from`.
function nextDropAfter(from: Date): Date {
  const target = new Date(from);
  target.setUTCHours(DROP_UTC_HOUR, 0, 0, 0);
  if (target.getTime() <= from.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target;
}

// Most recent 00:00 UTC boundary at or before `from` — used to detect whether
// we're inside the post-fire "dropping now" window.
function lastDropBefore(from: Date): Date {
  const target = new Date(from);
  target.setUTCHours(DROP_UTC_HOUR, 0, 0, 0);
  if (target.getTime() > from.getTime()) {
    target.setUTCDate(target.getUTCDate() - 1);
  }
  return target;
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  // Drop the hours segment once we're under an hour so the chip stays compact.
  return h > 0 ? `${h}h ${pad(m)}m ${pad(s)}s` : `${m}m ${pad(s)}s`;
}

export function NextDrop({ className }: { className?: string }) {
  // `null` until mounted so SSR and the first client render match (the server
  // can't know the user's "now" to the second). We render a stable skeleton
  // until the effect runs, avoiding a hydration mismatch.
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    // Seed the first value asynchronously (setTimeout callback, not the effect
    // body) so we don't synchronously setState inside the effect — the lint
    // rule forbids that as it can cascade renders. The 0ms timer paints the
    // live chip on the next tick; the placeholder shows for that one frame.
    const seed = setTimeout(() => setNow(new Date()), 0);
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => {
      clearTimeout(seed);
      clearInterval(id);
    };
  }, []);

  if (!now) {
    // Pre-hydration placeholder — same shape/size as the live chip.
    return (
      <div
        className={cn(
          "inline-flex items-center gap-2 rounded-full border border-border/60 bg-card px-3 py-1.5 shadow-soft",
          className,
        )}
        aria-hidden="true"
      >
        <Clock className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">
          Next drop
        </span>
        <span className="text-xs font-semibold tabular-nums text-foreground/40">
          —
        </span>
      </div>
    );
  }

  const since = now.getTime() - lastDropBefore(now).getTime();
  const dropping = since < DROP_WINDOW_MS;
  const target = nextDropAfter(now);
  const remaining = target.getTime() - now.getTime();

  // Friendly local time of the next drop, e.g. "5:00 PM" — helps the user
  // translate the UTC schedule into their own timezone without doing math.
  const localTime = target.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 shadow-soft transition-colors",
        dropping
          ? "border-state-warning-border bg-state-warning-bg"
          : "border-border/60 bg-card",
        className,
      )}
      title={
        dropping
          ? "A fresh batch of viral posts is being collected right now."
          : `New viral posts are pulled in daily at ${localTime} your time.`
      }
    >
      {dropping ? (
        <span className="relative flex h-2 w-2" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-state-warning opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-state-warning" />
        </span>
      ) : (
        <Clock className="h-3.5 w-3.5 text-muted-foreground" />
      )}
      <span
        className={cn(
          "text-xs font-medium",
          dropping ? "text-state-warning dark:text-state-warning" : "text-muted-foreground",
        )}
      >
        {dropping ? "Dropping now" : "Next drop"}
      </span>
      {dropping ? (
        <span className="text-xs font-semibold text-state-warning dark:text-state-warning">
          …
        </span>
      ) : (
        <span className="text-xs font-semibold tabular-nums text-foreground">
          {formatRemaining(remaining)}
        </span>
      )}
    </div>
  );
}
