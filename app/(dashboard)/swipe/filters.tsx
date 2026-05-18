"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition, useEffect } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
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
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {/* Sort */}
      <div className="inline-flex items-center rounded-full border border-border/70 bg-card overflow-hidden">
        <label className="px-3 py-1.5 text-muted-foreground border-r border-border/70">Sort</label>
        <select
          value={sort}
          onChange={(e) => update({ sort: e.target.value })}
          className="px-2.5 py-1.5 bg-card text-foreground font-medium outline-none cursor-pointer pr-7 appearance-none bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%2210%22 viewBox=%220 0 20 20%22 fill=%22%23666%22><path d=%22M5 8l5 5 5-5z%22/></svg>')] bg-no-repeat bg-[right_0.5rem_center]"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => update({ dir: dir === "desc" ? "asc" : "desc" })}
          className="grid place-items-center h-7 w-7 border-l border-border/70 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title={dir === "desc" ? "Descending — click for ascending" : "Ascending — click for descending"}
        >
          {dir === "desc" ? <ArrowDown className="h-3.5 w-3.5" /> : <ArrowUp className="h-3.5 w-3.5" />}
        </button>
      </div>

      {/* Date posted */}
      <div className="inline-flex items-center rounded-full border border-border/70 bg-card overflow-hidden">
        <label className="px-3 py-1.5 text-muted-foreground border-r border-border/70">Posted</label>
        <select
          value={since}
          onChange={(e) => update({ since: e.target.value })}
          className="px-2.5 py-1.5 bg-card text-foreground font-medium outline-none cursor-pointer pr-7 appearance-none bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%2210%22 viewBox=%220 0 20 20%22 fill=%22%23666%22><path d=%22M5 8l5 5 5-5z%22/></svg>')] bg-no-repeat bg-[right_0.5rem_center]"
        >
          {SINCE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* Post type */}
      <div className="inline-flex items-center rounded-full border border-border/70 bg-card overflow-hidden">
        <label className="px-3 py-1.5 text-muted-foreground border-r border-border/70">Type</label>
        <select
          value={type}
          onChange={(e) => update({ type: e.target.value })}
          className="px-2.5 py-1.5 bg-card text-foreground font-medium outline-none cursor-pointer pr-7 appearance-none bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%2210%22 viewBox=%220 0 20 20%22 fill=%22%23666%22><path d=%22M5 8l5 5 5-5z%22/></svg>')] bg-no-repeat bg-[right_0.5rem_center]"
        >
          {TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* Min reactions */}
      <NumericChip
        label="Min likes"
        value={minR}
        onChange={setMinR}
        onCommit={(v) => applyNumeric("minR", v)}
      />

      {/* Min comments */}
      <NumericChip
        label="Min comments"
        value={minC}
        onChange={setMinC}
        onCommit={(v) => applyNumeric("minC", v)}
      />

      {hasFilters && (
        <button
          type="button"
          onClick={() => { setMinR(""); setMinC(""); startTransition(() => router.push(niche ? `/swipe?niche=${encodeURIComponent(niche)}` : "/swipe")); }}
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground px-2 py-1 rounded-md hover:bg-muted transition-colors"
        >
          <X className="h-3 w-3" /> Reset
        </button>
      )}
    </div>
  );
}

function NumericChip({
  label, value, onChange, onCommit,
}: { label: string; value: string; onChange: (v: string) => void; onCommit: (v: string) => void }) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full border bg-card overflow-hidden transition-colors",
        value ? "border-primary/40" : "border-border/70",
      )}
    >
      <label className="px-3 py-1.5 text-muted-foreground border-r border-border/70">{label}</label>
      <input
        type="text"
        inputMode="numeric"
        value={value}
        placeholder="—"
        onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ""))}
        onBlur={(e) => onCommit(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        className="w-16 px-2.5 py-1.5 bg-card text-foreground font-medium outline-none tabular-nums text-center"
      />
    </div>
  );
}
