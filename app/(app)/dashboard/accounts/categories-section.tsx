"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, Loader2, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export type CategoryCreator = {
  id: string;
  name: string;
  linkedin_handle: string;
};

export type Category = {
  id: string;
  label: string;
  creators: CategoryCreator[];
};

export function CategoriesSection({
  categories,
  trackedAccountIds,
}: {
  categories: Category[];
  trackedAccountIds: string[];
}) {
  const router = useRouter();
  const trackedSet = useMemo(() => new Set(trackedAccountIds), [trackedAccountIds]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyCategory, setBusyCategory] = useState<string | null>(null);
  const [busyAccount, setBusyAccount] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const stats = useMemo(() => {
    const totalCreators = categories.reduce((s, c) => s + c.creators.length, 0);
    const trackedCount = categories.reduce(
      (s, c) => s + c.creators.filter((cr) => trackedSet.has(cr.id)).length,
      0,
    );
    const activeCategories = categories.filter((c) =>
      c.creators.some((cr) => trackedSet.has(cr.id)),
    ).length;
    return { totalCreators, trackedCount, activeCategories };
  }, [categories, trackedSet]);

  async function bulkToggle(cat: Category) {
    const trackedHere = cat.creators.filter((cr) => trackedSet.has(cr.id)).length;
    const isFullyTracked = trackedHere === cat.creators.length && cat.creators.length > 0;
    const action = isFullyTracked ? "untrack" : "track";

    if (action === "untrack" && trackedHere > 3) {
      const ok = confirm(`Untrack ${trackedHere} creators in ${cat.label}?`);
      if (!ok) return;
    }

    setBusyCategory(cat.id);
    try {
      const res = await fetch("/api/accounts/by-category", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category_ids: [cat.id], action }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      toast.success(
        action === "track"
          ? `Tracking ${data.affected} creators in ${cat.label}`
          : `Untracked ${data.affected} creators in ${cat.label}`,
      );
      startTransition(() => router.refresh());
    } catch (e) {
      toast.error((e as Error).message);
    }
    setBusyCategory(null);
  }

  async function toggleOne(creator: CategoryCreator) {
    const wasTracked = trackedSet.has(creator.id);
    setBusyAccount(creator.id);
    try {
      const action = wasTracked ? "untrack" : "track";
      const res = await fetch("/api/accounts/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: creator.id, action }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      toast.success(wasTracked ? `Untracked ${creator.name}` : `Tracking ${creator.name}`);
      startTransition(() => router.refresh());
    } catch (e) {
      toast.error((e as Error).message);
    }
    setBusyAccount(null);
  }

  if (categories.length === 0) return null;

  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-display text-lg tracking-tight">Categories</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Tracking{" "}
            <span className="font-medium text-foreground tabular-nums">
              {stats.trackedCount}
            </span>{" "}
            of{" "}
            <span className="tabular-nums">{stats.totalCreators}</span> creators across{" "}
            <span className="tabular-nums">{stats.activeCategories}</span>{" "}
            {stats.activeCategories === 1 ? "category" : "categories"}.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {categories.map((cat) => {
          const trackedHere = cat.creators.filter((cr) => trackedSet.has(cr.id)).length;
          const isAll = trackedHere === cat.creators.length && cat.creators.length > 0;
          const isPartial = trackedHere > 0 && !isAll;
          const isOpen = expanded === cat.id;
          const isBusy = busyCategory === cat.id;
          return (
            <div key={cat.id} className="inline-flex">
              <button
                type="button"
                onClick={() => bulkToggle(cat)}
                disabled={isBusy}
                className={cn(
                  "inline-flex items-center gap-1.5 pl-3 pr-2 py-1.5 text-xs rounded-l-full border border-r-0 transition-colors disabled:opacity-50",
                  isAll
                    ? "bg-primary text-primary-foreground border-primary hover:bg-primary/90"
                    : isPartial
                      ? "bg-accent text-foreground border-border hover:bg-accent/80"
                      : "bg-background text-muted-foreground border-border hover:text-foreground hover:bg-accent/60",
                )}
                title={isAll ? "Untrack all" : "Track all"}
              >
                {isBusy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : isAll ? (
                  <Check className="h-3 w-3" />
                ) : null}
                <span className="font-medium">{cat.label}</span>
                <span className="tabular-nums opacity-70">
                  {trackedHere}/{cat.creators.length}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setExpanded(isOpen ? null : cat.id)}
                aria-label={`Expand ${cat.label}`}
                className={cn(
                  "inline-flex items-center px-2 py-1.5 rounded-r-full border transition-colors",
                  isAll
                    ? "bg-primary text-primary-foreground border-primary hover:bg-primary/90"
                    : isPartial
                      ? "bg-accent text-foreground border-border hover:bg-accent/80"
                      : "bg-background text-muted-foreground border-border hover:text-foreground hover:bg-accent/60",
                )}
              >
                <ChevronDown
                  className={cn("h-3 w-3 transition-transform", isOpen && "rotate-180")}
                />
              </button>
            </div>
          );
        })}
      </div>

      {expanded &&
        (() => {
          const cat = categories.find((c) => c.id === expanded);
          if (!cat) return null;
          const trackedHere = cat.creators.filter((cr) => trackedSet.has(cr.id)).length;
          const noneTracked = trackedHere === 0;
          return (
            <div className="border-t border-border/60 pt-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs text-muted-foreground">
                  {cat.label} · {cat.creators.length} creator
                  {cat.creators.length === 1 ? "" : "s"}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyCategory === cat.id}
                    onClick={() => bulkToggle(cat)}
                  >
                    {noneTracked ? "Select all" : "Deselect all"}
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {cat.creators.map((cr) => {
                  const tracked = trackedSet.has(cr.id);
                  const busy = busyAccount === cr.id;
                  return (
                    <button
                      key={cr.id}
                      type="button"
                      onClick={() => toggleOne(cr)}
                      disabled={busy}
                      className={cn(
                        "flex items-center justify-between gap-3 px-3 py-1.5 rounded-md border text-sm transition-colors text-left disabled:opacity-50",
                        tracked
                          ? "border-primary/40 bg-primary/5 hover:bg-primary/10"
                          : "border-border hover:bg-accent/60",
                      )}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span
                          className={cn(
                            "h-3.5 w-3.5 shrink-0 rounded border flex items-center justify-center",
                            tracked
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border",
                          )}
                        >
                          {busy ? (
                            <Loader2 className="h-2.5 w-2.5 animate-spin" />
                          ) : tracked ? (
                            <Check className="h-2.5 w-2.5" />
                          ) : null}
                        </span>
                        <span className="truncate">{cr.name}</span>
                      </span>
                      <Badge variant="outline" className="text-[10px] font-normal shrink-0">
                        {cr.linkedin_handle}
                      </Badge>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })()}
    </Card>
  );
}
