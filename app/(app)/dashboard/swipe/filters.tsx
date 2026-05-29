"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition, useMemo, memo, useRef, useEffect } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, X, CalendarRange, FileType2, Heart, MessageCircle, Search } from "lucide-react";
import { cn } from "@/lib/utils";

const DEFAULT_SORT = "recent-viral";
const DEFAULT_REC = "new";

// "posted-desc" / "posted-asc" are surfaced as primary sort options (Newest /
// Oldest). They both map to sort=posted with dir flipped — collapsing the old
// "recency tiebreak" chip into the main sort dropdown so the label matches the
// actual ordering. Reactions / Comments still sort by engagement, with newer
// posts winning ties (the implicit, sensible default).
// "recent-viral" buckets by calendar day (newest day first), then ranks each
// day's posts by reactions DESC — the new default, since timestamp-precise
// `posted_at` makes a strict (date, reactions) tiebreak essentially never fire.
const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "recent-viral", label: "Recent & viral" },
  { value: "reactions", label: "Reactions" },
  { value: "comments", label: "Comments" },
  { value: "posted-desc", label: "Newest" },
  { value: "posted-asc", label: "Oldest" },
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
      sort: params.get("sort") || DEFAULT_SORT,
      dir: params.get("dir") || "desc",
      rec: params.get("rec") || DEFAULT_REC,
      type: params.get("type") || "all",
      category: params.get("category") || "",
      from: params.get("from") || "",
      to: params.get("to") || "",
      minR: params.get("minR") || "",
      minC: params.get("minC") || "",
      q: params.get("q") || "",
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
  // Creator search runs live (debounced) as the user types. We keep three
  // pieces of state in sync:
  //   q                — current input value
  //   qSeed            — snapshot of URL ?q= the last time we accepted a
  //                       server-driven change; flips local q back to match
  //                       on browser back / Reset
  //   qLastCommitted   — the value we most recently pushed *to* the URL via
  //                       the debounce; lets us distinguish our own writes
  //                       (no-op) from external changes (need to reseed).
  // Without qLastCommitted, our own debounced URL update would round-trip
  // back through useSearchParams → reseed → clobber an in-flight keystroke.
  const [q, setQ] = useState(snap.q);
  const [qSeed, setQSeed] = useState(snap.q);
  const qLastCommitted = useRef(snap.q);
  const qDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Reading qLastCommitted.current during render is intentional: it lets us
  // tell our *own* debounced URL write (which round-trips back through
  // useSearchParams) apart from an external change (browser back / Reset),
  // so we don't reseed local `q` and clobber an in-flight keystroke. A ref —
  // not state — is correct here precisely because we must read the latest
  // committed value synchronously without scheduling another render. The
  // React Compiler flags any render-time ref read; this one is safe because
  // it only *reads* (never mutates) the ref during render and the value is
  // updated exclusively from event handlers.
  // eslint-disable-next-line react-hooks/refs -- intentional render-time read to distinguish self-writes from external URL changes
  if (snap.q !== qSeed && snap.q !== qLastCommitted.current) {
    setQSeed(snap.q);
    setQ(snap.q);
  } else if (snap.q !== qSeed) {
    // Our own debounced commit just landed. Reseed without touching local q.
    setQSeed(snap.q);
  }
  useEffect(() => {
    return () => {
      if (qDebounceTimer.current) clearTimeout(qDebounceTimer.current);
    };
  }, []);

  function update(patch: Record<string, string | null>) {
    const next = new URLSearchParams(snap.raw.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (
        v === null ||
        v === "" ||
        (k === "sort" && v === DEFAULT_SORT) ||
        (k === "dir" && v === "desc") ||
        (k === "rec" && v === DEFAULT_REC) ||
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

  function applyQuery(value: string) {
    // Trim and collapse whitespace — users often paste names with extra spaces.
    const cleaned = value.trim().replace(/\s+/g, " ");
    if (qDebounceTimer.current) {
      clearTimeout(qDebounceTimer.current);
      qDebounceTimer.current = null;
    }
    if (cleaned === qLastCommitted.current) return;
    qLastCommitted.current = cleaned;
    update({ q: cleaned || null });
  }

  // Debounced live search: 300ms after the user stops typing, push the
  // current input value to the URL so the server re-queries. Enter and blur
  // still flush immediately via applyQuery — the debounce just removes the
  // need to press them.
  function setQLive(value: string) {
    setQ(value);
    if (qDebounceTimer.current) clearTimeout(qDebounceTimer.current);
    qDebounceTimer.current = setTimeout(() => {
      qDebounceTimer.current = null;
      applyQuery(value);
    }, 300);
  }

  function reset() {
    setMinR("");
    setMinC("");
    setQ("");
    if (qDebounceTimer.current) {
      clearTimeout(qDebounceTimer.current);
      qDebounceTimer.current = null;
    }
    qLastCommitted.current = "";
    startTransition(() => {
      // Preserve category across reset.
      const params = new URLSearchParams();
      if (snap.category) params.set("category", snap.category);
      const qs = params.toString();
      router.replace(qs ? `/dashboard/swipe?${qs}` : "/dashboard/swipe", {
        scroll: false,
      });
    });
  }

  const hasFilters =
    snap.sort !== DEFAULT_SORT ||
    snap.dir !== "desc" ||
    snap.rec !== DEFAULT_REC ||
    snap.type !== "all" ||
    minR ||
    minC ||
    q ||
    snap.from ||
    snap.to;

  // The sort dropdown surfaces 5 options but the URL only stores 2 params
  // (sort + dir). Posted-date is encoded as a combined value so the select can
  // distinguish "Newest" from "Oldest" — splitting back into sort/dir happens
  // in handleSortChange below. "recent-viral" has no meaningful direction
  // (the ordering is intrinsically newest-day-first, highest-reaction-first).
  const sortValue =
    snap.sort === "posted"
      ? (snap.dir === "asc" ? "posted-asc" : "posted-desc")
      : snap.sort;
  const hideDirFlip = snap.sort === "posted" || snap.sort === "recent-viral";

  function handleSortChange(v: string) {
    if (v === "posted-desc") update({ sort: "posted", dir: "desc" });
    else if (v === "posted-asc") update({ sort: "posted", dir: "asc" });
    else if (v === "recent-viral") update({ sort: v, dir: null });
    else update({ sort: v });
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5 text-xs", isPending && "opacity-90")}>
      {/* Creator search — matches against accounts.name / linkedin_handle.
          Live: 300ms after the user stops typing, the URL updates and the
          server re-queries. Enter/blur flush immediately. */}
      <SearchChip
        value={q}
        onChange={setQLive}
        onCommit={applyQuery}
        onClear={() => { setQ(""); applyQuery(""); }}
      />

      {/* Sort */}
      <SelectChip
        icon={<ArrowUpDown className="h-3.5 w-3.5" />}
        value={sortValue}
        defaultValue={DEFAULT_SORT}
        options={SORT_OPTIONS}
        onChange={handleSortChange}
      >
        {/* Dir-flip arrow only meaningful for reactions/comments — when the
            user picks Newest/Oldest, direction is already baked into the label. */}
        {!hideDirFlip && (
          <button
            type="button"
            onClick={() => update({ dir: snap.dir === "desc" ? "asc" : "desc" })}
            className="self-stretch grid place-items-center w-8 border-l border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/70 transition-colors"
            aria-label={snap.dir === "desc" ? "Sort descending — click for ascending" : "Sort ascending — click for descending"}
            title={snap.dir === "desc" ? "Descending — click to flip" : "Ascending — click to flip"}
          >
            {snap.dir === "desc" ? <ArrowDown className="h-3.5 w-3.5" /> : <ArrowUp className="h-3.5 w-3.5" />}
          </button>
        )}
      </SelectChip>

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

const SearchChip = memo(function SearchChip({
  value, onChange, onCommit, onClear,
}: { value: string; onChange: (v: string) => void; onCommit: (v: string) => void; onClear: () => void }) {
  const active = !!value;
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full border bg-card overflow-hidden transition-all h-8",
        active ? "border-primary/40 ring-1 ring-primary/15" : "border-border/60 hover:border-border",
      )}
    >
      <span className={cn("pl-3 pr-1.5 grid place-items-center", active ? "text-primary" : "text-muted-foreground")}>
        <Search className="h-3.5 w-3.5" />
      </span>
      <input
        type="text"
        value={value}
        placeholder="Creator name"
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onCommit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") onClear();
        }}
        aria-label="Search by creator name"
        className={cn(
          "py-1.5 bg-transparent text-foreground font-medium outline-none",
          active ? "pl-1 pr-1 w-36" : "pl-1 pr-3 w-44 placeholder:text-muted-foreground placeholder:font-normal",
        )}
      />
      {active && (
        <button
          type="button"
          onClick={onClear}
          className="self-stretch grid place-items-center w-7 pr-2 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Clear creator search"
        >
          <X className="h-3 w-3" />
        </button>
      )}
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
