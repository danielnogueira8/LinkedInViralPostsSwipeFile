"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Check, Loader2, Users } from "lucide-react";
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
  const [drilldown, setDrilldown] = useState<string | null>(null);
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
      c.creators.length > 0 && c.creators.every((cr) => trackedSet.has(cr.id)),
    ).length;
    return { totalCreators, trackedCount, activeCategories };
  }, [categories, trackedSet]);

  async function bulkToggle(cat: Category, force?: "track" | "untrack") {
    const trackedHere = cat.creators.filter((cr) => trackedSet.has(cr.id)).length;
    const isFullyTracked = trackedHere === cat.creators.length && cat.creators.length > 0;
    const action = force ?? (isFullyTracked ? "untrack" : "track");

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

  const drilldownCat = drilldown ? categories.find((c) => c.id === drilldown) ?? null : null;

  return (
    <Card className="p-5 space-y-4">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-display text-lg tracking-tight">Browse by category</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Tracking{" "}
            <span className="font-medium text-foreground tabular-nums">
              {stats.trackedCount}
            </span>{" "}
            of <span className="tabular-nums">{stats.totalCreators}</span> creators ·{" "}
            <span className="tabular-nums">{stats.activeCategories}</span>{" "}
            {stats.activeCategories === 1 ? "category" : "categories"} fully tracked
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
        {categories.map((cat) => {
          const trackedHere = cat.creators.filter((cr) => trackedSet.has(cr.id)).length;
          const total = cat.creators.length;
          const isAll = trackedHere === total && total > 0;
          const isPartial = trackedHere > 0 && !isAll;
          const isEmpty = total === 0;
          const isBusy = busyCategory === cat.id;
          const sample = cat.creators.slice(0, 3).map((c) => c.name).join(", ");

          return (
            <div
              key={cat.id}
              className={cn(
                "group relative rounded-lg border p-3.5 transition-colors flex flex-col gap-2",
                isAll
                  ? "border-primary/40 bg-primary/5"
                  : isPartial
                    ? "border-border bg-accent/30"
                    : "border-border bg-background hover:bg-accent/40",
                isEmpty && "opacity-60",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm leading-tight">{cat.label}</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5 tabular-nums flex items-center gap-1">
                    <Users className="h-3 w-3" />
                    {total} creator{total === 1 ? "" : "s"}
                    {trackedHere > 0 && (
                      <>
                        <span className="text-border">·</span>
                        <span
                          className={cn(
                            "font-medium",
                            isAll ? "text-primary" : "text-foreground",
                          )}
                        >
                          {isAll ? "all tracked" : `${trackedHere} tracked`}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                {isAll && (
                  <Badge className="h-5 px-1.5 text-[10px] gap-0.5 shrink-0">
                    <Check className="h-2.5 w-2.5" />
                    Tracked
                  </Badge>
                )}
              </div>

              {sample && (
                <div className="text-[11px] text-muted-foreground italic truncate">
                  e.g. {sample}
                  {total > 3 && `, +${total - 3} more`}
                </div>
              )}

              <div className="flex items-center gap-1.5 pt-1 mt-auto">
                <Button
                  size="sm"
                  variant={isAll ? "outline" : "default"}
                  disabled={isBusy || isEmpty}
                  onClick={() => bulkToggle(cat)}
                  className="h-7 text-xs flex-1"
                >
                  {isBusy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : isAll ? (
                    "Untrack all"
                  ) : isPartial ? (
                    `Track all (${total - trackedHere} more)`
                  ) : (
                    "Track all"
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={isEmpty}
                  onClick={() => setDrilldown(cat.id)}
                  className="h-7 text-xs"
                >
                  Pick…
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <Dialog
        open={drilldownCat !== null}
        onOpenChange={(open) => !open && setDrilldown(null)}
      >
        <DialogContent className="max-w-2xl">
          {drilldownCat && (
            <>
              <DialogHeader>
                <DialogTitle>{drilldownCat.label}</DialogTitle>
                <DialogDescription>
                  {(() => {
                    const trackedHere = drilldownCat.creators.filter((cr) =>
                      trackedSet.has(cr.id),
                    ).length;
                    return (
                      <>
                        <span className="tabular-nums">{trackedHere}</span> of{" "}
                        <span className="tabular-nums">{drilldownCat.creators.length}</span>{" "}
                        tracked. Click a creator to toggle.
                      </>
                    );
                  })()}
                </DialogDescription>
              </DialogHeader>

              <div className="flex items-center justify-end gap-2 -mt-1">
                {(() => {
                  const trackedHere = drilldownCat.creators.filter((cr) =>
                    trackedSet.has(cr.id),
                  ).length;
                  const isAll = trackedHere === drilldownCat.creators.length;
                  return (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyCategory === drilldownCat.id}
                      onClick={() =>
                        bulkToggle(drilldownCat, isAll ? "untrack" : "track")
                      }
                    >
                      {busyCategory === drilldownCat.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : isAll ? (
                        "Deselect all"
                      ) : (
                        "Select all"
                      )}
                    </Button>
                  );
                })()}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-[60vh] overflow-y-auto pr-1">
                {drilldownCat.creators.map((cr) => {
                  const tracked = trackedSet.has(cr.id);
                  const busy = busyAccount === cr.id;
                  return (
                    <button
                      key={cr.id}
                      type="button"
                      onClick={() => toggleOne(cr)}
                      disabled={busy}
                      className={cn(
                        "flex items-center justify-between gap-3 px-3 py-2 rounded-md border text-sm transition-colors text-left disabled:opacity-50",
                        tracked
                          ? "border-primary/40 bg-primary/5 hover:bg-primary/10"
                          : "border-border hover:bg-accent/60",
                      )}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span
                          className={cn(
                            "h-4 w-4 shrink-0 rounded border flex items-center justify-center",
                            tracked
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border",
                          )}
                        >
                          {busy ? (
                            <Loader2 className="h-2.5 w-2.5 animate-spin" />
                          ) : tracked ? (
                            <Check className="h-3 w-3" />
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
            </>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
