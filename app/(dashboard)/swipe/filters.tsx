"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition, useEffect } from "react";
import { ArrowDown, ArrowUp, X, ArrowUpDown, Calendar, FileType2, Heart, MessageCircle } from "lucide-react";
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

export function SwipeFilters() {
  const router = useRouter();
  const params = useSearchParams();
  const [, startTransition] = useTransition();

  const sort = params.get("sort") || "viral";
  const dir = params.get("dir") || "desc";
  const since = params.get("since") || "all";
  const type = params.get("type") || "all";
  const niche = params.get("niche") || "";

  // local state for numeric inputs so typing isn't laggy
  const [minR, setMinR] = useState(params.get("minR") || "");
  const [minC, setMinC] = useState(params.get("minC") || "");

  // keep local state in sync if URL changes (e.g. browser back)
  useEffect(() => { setMinR(params.get("minR") || ""); }, [params]);
  useEffect(() => { setMinC(params.get("minC") || ""); }, [params]);

  function update(patch: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "" || (k === "sort" && v === "viral") || (k === "dir" && v === "desc") || (k === "since" && v === "all") || (k === "type" && v === "all")) {
        next.delete(k);
      } else {
        next.set(k, v);
      }
    }
    const qs = next.toString();
    startTransition(() => router.push(qs ? `/swipe?${qs}` : "/swipe"));
  }

  function applyNumeric(key: "minR" | "minC", value: string) {
    // strip non-digits, allow empty
    const cleaned = value.replace(/[^\d]/g, "");
    update({ [key]: cleaned || null });
  }

  const hasFilters = sort !== "viral" || dir !== "desc" || since !== "all" || type !== "all" || minR || minC;

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      {/* Sort */}
      <SelectChip
        icon={<ArrowUpDown className="h-3.5 w-3.5" />}
        value={sort}
        defaultValue="viral"
        options={SORT_OPTIONS}
        onChange={(v) => update({ sort: v })}
      >
        <button
          type="button"
          onClick={() => update({ dir: dir === "desc" ? "asc" : "desc" })}
          className="grid place-items-center h-7 w-7 border-l border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/70 transition-colors -mr-1 rounded-r-full"
          title={dir === "desc" ? "Descending — click for ascending" : "Ascending — click for descending"}
        >
          {dir === "desc" ? <ArrowDown className="h-3.5 w-3.5" /> : <ArrowUp className="h-3.5 w-3.5" />}
        </button>
      </SelectChip>

      {/* Date posted */}
      <SelectChip
        icon={<Calendar className="h-3.5 w-3.5" />}
        value={since}
        defaultValue="all"
        options={SINCE_OPTIONS}
        onChange={(v) => update({ since: v })}
      />

      {/* Post type */}
      <SelectChip
        icon={<FileType2 className="h-3.5 w-3.5" />}
        value={type}
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
          onClick={() => { setMinR(""); setMinC(""); startTransition(() => router.push(niche ? `/swipe?niche=${encodeURIComponent(niche)}` : "/swipe")); }}
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground px-2 py-1.5 rounded-md hover:bg-muted/70 transition-colors ml-auto"
        >
          <X className="h-3 w-3" /> Reset
        </button>
      )}
    </div>
  );
}

function SelectChip({
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
}

function NumericChip({
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
}
