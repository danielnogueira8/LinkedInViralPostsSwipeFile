"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AudioLines,
  CalendarCheck,
  Check,
  Link2,
  ListChecks,
  Search,
  X,
} from "lucide-react";
import { AiIcon } from "@/components/ai-icon";
import { cn } from "@/lib/utils";

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

const STEPS = [
  { key: "creators" as const, label: "Track creators", href: "/dashboard/accounts", icon: ListChecks },
  { key: "voice" as const, label: "Set up voice", href: "/dashboard/voice", icon: AudioLines },
  { key: "linkedin" as const, label: "Connect LinkedIn", href: "/dashboard/settings", icon: Link2 },
  { key: "inspiration" as const, label: "Fill inspiration", href: "/dashboard/swipe", icon: Search },
  { key: "batch" as const, label: "Generate a batch", href: "/dashboard", icon: AiIcon },
  { key: "scheduled" as const, label: "Schedule a post", href: "/dashboard/posts", icon: CalendarCheck },
];

// Compact first-run setup checklist for the LEFT SIDEBAR (sits between the nav
// and the user card). Persists until the user dismisses it (permanent,
// workspace-scoped via POST /api/onboarding/checklist) OR every item is done
// (auto-hides). Best-effort: any fetch failure just renders nothing, never an
// error. `forceShow` (dev/preview only) renders the card even when the API says
// it's complete/dismissed, so the design can be reviewed without a fresh
// account.
export function FirstRunChecklist({ forceShow = false }: { forceShow?: boolean }) {
  const [items, setItems] = useState<ChecklistState>(DEFAULT_STATE);
  const [state, setState] = useState<"loading" | "shown" | "hidden">("loading");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/onboarding/checklist")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const next = data?.ok && data.items ? { ...DEFAULT_STATE, ...data.items } : DEFAULT_STATE;
        setItems(next);
        const allDone = Object.values(next).every(Boolean);
        // Auto-hide when dismissed or fully complete (unless forced for preview).
        setState(!forceShow && (data?.dismissed || allDone) ? "hidden" : "shown");
      })
      .catch(() => {
        if (!cancelled) setState(forceShow ? "shown" : "hidden");
      });
    return () => {
      cancelled = true;
    };
  }, [forceShow]);

  async function dismiss() {
    setState("hidden");
    try {
      await fetch("/api/onboarding/checklist", { method: "POST" });
    } catch {
      /* best-effort — the local hide already happened */
    }
  }

  if (state !== "shown") return null;

  const completed = STEPS.filter((s) => items[s.key]).length;

  return (
    <div className="rounded-xl border border-border bg-card p-2.5 shadow-soft">
      <div className="flex items-center justify-between gap-2 px-0.5">
        <div className="text-xs font-semibold text-foreground">
          Setup
          <span className="ml-1.5 font-normal text-muted-foreground tabular-nums">
            {completed}/{STEPS.length}
          </span>
        </div>
        <button
          type="button"
          onClick={dismiss}
          title="Dismiss setup checklist"
          aria-label="Dismiss setup checklist"
          className="grid h-5 w-5 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-2 flex flex-col gap-0.5">
        {STEPS.map((step) => {
          const done = items[step.key];
          const Icon = step.icon;
          return (
            <Link
              key={step.key}
              href={step.href}
              className={cn(
                "flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-[13px] transition-colors",
                done ? "text-muted-foreground" : "text-foreground hover:bg-accent/60",
              )}
            >
              <span
                className={cn(
                  "grid h-4 w-4 shrink-0 place-items-center rounded-full",
                  done
                    ? "bg-state-success text-white"
                    : "border border-border text-muted-foreground",
                )}
              >
                {done ? <Check className="h-2.5 w-2.5" /> : <Icon className="h-2.5 w-2.5" />}
              </span>
              <span className={cn("truncate", done && "line-through")}>{step.label}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
