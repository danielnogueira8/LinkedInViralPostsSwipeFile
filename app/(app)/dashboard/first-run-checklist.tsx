"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AudioLines,
  CalendarCheck,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  ListChecks,
  Search,
  WandSparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";

const COLLAPSE_KEY = "swipein:first-run-checklist-collapsed";

type ChecklistState = {
  voice: boolean;
  linkedin: boolean;
  creators: boolean;
  inspiration: boolean;
  batch: boolean;
  scheduled: boolean;
};

const DEFAULT_STATE: ChecklistState = {
  voice: false,
  linkedin: false,
  creators: false,
  inspiration: false,
  batch: false,
  scheduled: false,
};

export function FirstRunChecklist() {
  const [items, setItems] = useState<ChecklistState>(DEFAULT_STATE);
  const [loaded, setLoaded] = useState(false);
  const [collapsed, setCollapsed] = useState(
    () =>
      typeof window !== "undefined" &&
      window.sessionStorage.getItem(COLLAPSE_KEY) === "1",
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/onboarding/checklist")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.ok && data.items) setItems({ ...DEFAULT_STATE, ...data.items });
      })
      .catch(() => {
        /* Best-effort guidance only. */
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const steps = useMemo(
    () => [
      {
        key: "voice" as const,
        label: "Set up voice",
        href: "/dashboard/voice",
        icon: AudioLines,
      },
      {
        key: "linkedin" as const,
        label: "Connect LinkedIn",
        href: "/dashboard/settings",
        icon: ExternalLink,
      },
      {
        key: "creators" as const,
        label: "Track creators",
        href: "/dashboard/accounts",
        icon: ListChecks,
      },
      {
        key: "inspiration" as const,
        label: "Fill Inspiration",
        href: "/dashboard/swipe",
        icon: Search,
      },
      {
        key: "batch" as const,
        label: "Generate first batch",
        href: "/dashboard",
        icon: WandSparkles,
      },
      {
        key: "scheduled" as const,
        label: "Schedule first post",
        href: "/dashboard/posts",
        icon: CalendarCheck,
      },
    ],
    [],
  );
  const completed = steps.filter((step) => items[step.key]).length;
  const allDone = completed === steps.length;
  const visibleSteps = collapsed ? steps.filter((step) => !items[step.key]).slice(0, 2) : steps;

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    window.sessionStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
  }

  if (!loaded && collapsed) return null;

  return (
    <div className="w-full max-w-4xl rounded-2xl border border-zinc-200/80 bg-white/82 p-3 text-left shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-zinc-950">
            First-run checklist
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {allDone
              ? "Workspace basics are ready."
              : `${completed}/${steps.length} complete. Finish the setup once, then Cowork has everything it needs.`}
          </div>
        </div>
        <button
          type="button"
          onClick={toggleCollapsed}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full border border-zinc-200 bg-white px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {collapsed ? "Show" : "Collapse"}
          {collapsed ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
        </button>
      </div>
      {visibleSteps.length > 0 && (
        <div className="mt-3 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {visibleSteps.map((step) => {
            const done = items[step.key];
            const Icon = step.icon;
            return (
              <Link
                key={step.key}
                href={step.href}
                className={cn(
                  "flex items-center gap-2 rounded-xl border px-2.5 py-2 text-sm transition-colors",
                  done
                    ? "border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-900"
                    : "border-zinc-200 bg-white text-zinc-800 hover:border-primary/25 hover:text-primary",
                )}
              >
                <span
                  className={cn(
                    "grid h-7 w-7 shrink-0 place-items-center rounded-lg",
                    done ? "bg-emerald-500 text-white" : "bg-[#f7f4ee] text-muted-foreground",
                  )}
                >
                  {done ? <Check className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}
                </span>
                <span className={cn("truncate font-medium", done && "line-through")}>
                  {step.label}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
