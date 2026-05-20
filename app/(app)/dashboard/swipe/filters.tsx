"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition, useMemo, memo } from "react";
import { ArrowDown, ArrowUp, X, ArrowUpDown, Calendar, CalendarRange, FileType2, Heart, MessageCircle } from "lucide-react";
import { cn } from "@/lib/utils";

const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "viral", label: "Top engagement" },
  { value: "reactions", label: "Reactions" },
  { value: "comments", label: "Comments" },
  { value: "posted", label: "Date posted" },
];

const SINCE_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "1d", label: "Last 24h" },
  { value: "7d", label: "Last 7d" },
  { value: "30d", label: "Last 30d" },
];

const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All posts" },
  { value: "regular", label: "Regular" },
  { value: "lead_magnet", label: "Lead magnet" },
];

// Snapshot the search params into a plain object so we don't pass the live
// URLSearchParams instance through React's dependency comparator on every render
// (it's a fresh reference each render → useEffect would always refire).
function useParamsSnapshot() {
  const params = useSearchParams();
  return useMemo(() => {
    return {
      sort: params.get("sort") || "viral",
      dir: params.get("dir") || "desc",
      since: params.get("since") || "all",
      type: params.get("type") || "all",
      niche: params.get("niche") || "",
      from: params.get("from") || "",
      to: params.get("to") || "",
      minR: params.get("minR") || "",
      minC: params.get("minC") || "",
      raw: params,
    };
  }, [params]);
}

export function SwipeFilters() {
  const router = useRouter();
  const snap = useParamsSnapshot();
  const [isPending, startTransition] = useTransition();

  // Local state for numeric inputs so typing isn't laggy. We reset on URL
  // change (browser back, reset button) using the "adjust state during render"
  // pattern — cheaper and lint-clean compared to a useEffect that just calls
  // setState. See https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [minR, setMinR] = useState(snap.minR);
  const [minRSeed, setMinRSeed] = useState(snap.minR);
  if (snap.minR !== minRSeed) {
    setMinRSeed(snap.minR);
    setMinR(snap.minR);
  }
  const [minC, setMinC] = useState(snap.minC);
  const [minCSeed, setMinCSeed] = useState(snap.minC);
  if (snap.minC !== minCSeed) {
    setMinCSeed(snap.minC);
    setMinC(snap.minC);
  }

  function update(patch: Record<string, string | null>) {
    const next = new URLSearchParams(snap.raw.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (
        v === null ||
        v === "" ||
        (k === "sort" && v === "viral") ||
        (k === "dir" && v === "desc") ||
        (k === "since" && v === "all") ||
        (k === "type" && v === "all")
      ) {
        next.delete(k);
      } else {
        next.set(k, v);
      }
    }
    const qs = next.toString();
    // `replace` (not push) — filter toggles shouldn't pile up in browser history.
    // `scroll: false` — keep the user's scroll position when results re-render.
    startTransition(() => {
      router.replace(qs ? `/dashboard/swipe?${qs}` : "/dashboard/swipe", { scroll: false });
    });
  }

  function applyNumeric(key: "minR" | "minC", value: string) {
    const cleaned = value.replace(/[^\d]/g, "");
    update({ [key]: cleaned || null });
  }

  function reset() {
    setMinR("");
    setMinC("");
    startTransition(() => {
      router.replace(
        snap.niche ? `/dashboard/swipe?niche=${encodeURIComponent(snap.niche)}` : "/dashboard/swipe",
        { scroll: false },
      );
    });
  }

  const hasFilters =
    snap.sort !== "viral" ||
    snap.dir !== "desc" ||
    snap.since !== "all" ||
    snap.type !== "all" ||
    minR ||
    minC ||
    snap.from ||
    snap.to;

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5 text-xs", isPending && "opacity-90")}>
      {/* Sort */}
      <SelectChip
        icon={<ArrowUpDown className="h-3.5 w-3.5" />}
        value={snap.sort}
        defaultValue="viral"
        options={SORT_OPTIONS}
        onChange={(v) => update({ sort: v })}
      >
        <button
          type="button"
          onClick={() => update({ dir: snap.dir === "desc" ? "asc" : "desc" })}
          className="grid place-items-center h-7 w-7 border-l border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/70 transition-colors -mr-1 rounded-r-full"
          title={snap.dir === "desc" ? "Descending — click for ascending" : "Ascending — click for descending"}
        >
          {snap.dir === "desc" ? <ArrowDown className="h-3.5 w-3.5" /> : <ArrowUp className="h-3.5 w-3.5" />}
        </button>
      </SelectChip>

      {/* Date posted */}
      <SelectChip
        icon={<Calendar className="h-3.5 w-3.5" />}
        value={snap.since}
        defaultValue="all"
        options={SINCE_OPTIONS}
        onChange={(v) => update({ since: v })}
      />

      {/* Date range */}
      <DateRangeChip
        from={snap.from}
        to={snap.to}
        onChange={(f, t) => update({ from: f || null, to: t || null })}
      />

      {/* Post type */}
      <SelectChip
        icon={<FileType2 className="h-3.5 w-3.5" />}
        value={snap.type}
        defaultValue="all"
        options={TYPE_OPTIONS}
        onChange={(v) => update({ type: v })}
      />

      <div className="w-px h-5 bg-border/60 mx-1 hidden sm:block" />

      {/* Min reactions */}
      <NumericChip
        icon={<Heart className="h-3.5 w-3.5" />}
        label="Min likes"
        value={minR}
        onChange={setMinR}
        onCommit={(v) => applyNumeric("minR", v)}
      />

      {/* Min comments */}
      <NumericChip
        icon={<MessageCircle className="h-3.5 w-3.5" />}
        label="Min comments"
        value={minC}
        onChange={setMinC}
        onCommit={(v) => applyNumeric("minC", v)}
      />

      {hasFilters && (
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground px-2 py-1.5 rounded-md hover:bg-muted/70 transition-colors ml-auto"
        >
          <X className="h-3 w-3" /> Reset
        </button>
      )}
    </div>
  );
}

const SelectChip = memo(function SelectChip({
  icon, value, defaultValue, options, onChange, children,
}: {
  icon: React.ReactNode;
  value: string;
  defaultValue: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  children?: React.ReactNode;
}) {
  const active = value !== defaultValue;
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full border bg-card overflow-hidden transition-all h-8",
        active ? "border-primary/40 ring-1 ring-primary/15" : "border-border/60 hover:border-border",
      )}
    >
      <span className={cn("pl-3 pr-1.5 grid place-items-center", active ? "text-primary" : "text-muted-foreground")}>
        {icon}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="pl-1 pr-7 py-1.5 bg-transparent text-foreground font-medium outline-none cursor-pointer appearance-none bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%2210%22 viewBox=%220 0 20 20%22 fill=%22%23999%22><path d=%22M5 8l5 5 5-5z%22/></svg>')] bg-no-repeat bg-[right_0.5rem_center]"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {children}
    </div>
  );
});

const DateRangeChip = memo(function DateRangeChip({
  from, to, onChange,
}: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  const active = !!from || !!to;
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full border bg-card overflow-hidden transition-all h-8",
        active ? "border-primary/40 ring-1 ring-primary/15" : "border-border/60 hover:border-border",
      )}
    >
      <span className={cn("pl-3 pr-1.5 grid place-items-center", active ? "text-primary" : "text-muted-foreground")}>
        <CalendarRange className="h-3.5 w-3.5" />
      </span>
      <input
        type="date"
        value={from}
        max={to || undefined}
        onChange={(e) => onChange(e.target.value, to)}
        aria-label="From date"
        className={cn(
          "px-1.5 py-1.5 bg-transparent text-foreground font-medium outline-none tabular-nums text-xs",
          from ? "text-foreground" : "text-muted-foreground",
        )}
      />
      <span className="text-muted-foreground px-0.5">–</span>
      <input
        type="date"
        value={to}
        min={from || undefined}
        onChange={(e) => onChange(from, e.target.value)}
        aria-label="To date"
        className={cn(
          "px-1.5 py-1.5 pr-3 bg-transparent text-foreground font-medium outline-none tabular-nums text-xs",
          to ? "text-foreground" : "text-muted-foreground",
        )}
      />
    </div>
  );
});

const NumericChip = memo(function NumericChip({
  icon, label, value, onChange, onCommit,
}: { icon: React.ReactNode; label: string; value: string; onChange: (v: string) => void; onCommit: (v: string) => void }) {
  const active = !!value;
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full border bg-card overflow-hidden transition-all h-8",
        active ? "border-primary/40 ring-1 ring-primary/15" : "border-border/60 hover:border-border",
      )}
    >
      <span className={cn("pl-3 pr-1.5 grid place-items-center", active ? "text-primary" : "text-muted-foreground")}>
        {icon}
      </span>
      <input
        type="text"
        inputMode="numeric"
        value={value}
        placeholder={label}
        onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ""))}
        onBlur={(e) => onCommit(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        className={cn(
          "px-2 py-1.5 bg-transparent text-foreground font-medium outline-none tabular-nums",
          active ? "w-16 text-center" : "w-24 text-left placeholder:text-muted-foreground placeholder:font-normal",
        )}
      />
    </div>
  );
});
