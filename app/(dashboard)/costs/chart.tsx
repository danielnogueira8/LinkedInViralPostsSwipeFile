"use client";

import { useState } from "react";

type Row = { day: string; anthropic: number; apify: number; total: number };

export function CostChart({ daily }: { daily: Row[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...daily.map((d) => d.total), 0.001);

  // Fill missing days for last 30 so the x axis is contiguous
  const days: Row[] = [];
  const seen = new Map(daily.map((d) => [d.day, d]));
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push(seen.get(key) ?? { day: key, anthropic: 0, apify: 0, total: 0 });
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-4 text-xs">
        <Legend color="bg-violet-500" label="Anthropic" />
        <Legend color="bg-blue-500" label="Apify" />
      </div>
      <div className="relative h-40 flex items-end gap-[2px] border-b border-l">
        {days.map((d, i) => {
          const total = d.total;
          const pct = (total / max) * 100;
          const aPct = total > 0 ? (d.anthropic / total) * 100 : 0;
          return (
            <div
              key={i}
              className="flex-1 flex flex-col-reverse hover:opacity-80 transition-opacity cursor-pointer relative"
              style={{ height: `${pct}%`, minHeight: total > 0 ? "2px" : "1px" }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              <div className="bg-blue-500" style={{ height: `${100 - aPct}%` }} />
              <div className="bg-violet-500" style={{ height: `${aPct}%` }} />
              {hover === i && (
                <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-popover border rounded shadow text-xs p-2 whitespace-nowrap z-10">
                  <div className="font-medium mb-1">{new Date(d.day).toLocaleDateString()}</div>
                  <div className="text-violet-500">Anthropic: ${d.anthropic.toFixed(5)}</div>
                  <div className="text-blue-500">Apify: ${d.apify.toFixed(5)}</div>
                  <div className="border-t mt-1 pt-1">Total: ${d.total.toFixed(5)}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
        <span>{new Date(days[0].day).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
        <span>{new Date(days[days.length - 1].day).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-muted-foreground">
      <div className={`h-2 w-2 rounded-sm ${color}`} />
      {label}
    </div>
  );
}
