"use client";

import { AlertTriangle } from "lucide-react";
import { AiIcon } from "@/components/ai-icon";
import { cn } from "@/lib/utils";
import type { TurnDecision } from "@/lib/agent/turn/resolve-decision";

// "Confirm before generating" read-back. Shows the resolved decision — mode,
// count, niche, post type, source — plus amber flags for any setting that
// won't take effect, so a silent override never surprises the user. Styled in
// the workspace's reference system: near-black chrome, coral as a lone accent,
// amber reserved for the conflict flags.

function humanTaskKind(kind: string): string {
  if (kind === "ideas") return "ideas";
  if (kind === "answer") return "an answer";
  return "post";
}

/** A one-line, plain-language summary of what the turn will do. */
export function summarize(decision: TurnDecision): string {
  const count = decision.postCount ?? 1;
  const noun =
    decision.taskKind === "ideas"
      ? `${count} post idea${count === 1 ? "" : "s"}`
      : decision.taskKind === "answer"
        ? "an answer"
        : `${count} ${decision.postType === "lead_magnet" ? "lead-magnet " : ""}post${count === 1 ? "" : "s"}`;
  const where =
    decision.niche === null
      ? decision.taskKind === "ideas"
        ? " across all your niches"
        : ""
      : ` in your ${decision.niche} niche`;
  const verb =
    decision.mode === "edit"
      ? "Edit"
      : decision.taskKind === "ideas"
        ? "Brainstorm"
        : "Write";
  const source = decision.hasModelSource
    ? ", modeled on your source post"
    : decision.hasCreatorStyle
      ? ", in your chosen creator style"
      : "";
  return `${verb} ${noun}${where}${source}.`;
}

type Chip = { label: string; value: string };

export function chips(decision: TurnDecision): Chip[] {
  const list: Chip[] = [
    {
      label: "Mode",
      value:
        decision.mode === "create"
          ? `Create · ${humanTaskKind(decision.taskKind)}`
          : decision.mode === "edit"
            ? "Edit"
            : `Ask · ${humanTaskKind(decision.taskKind)}`,
    },
  ];
  if (decision.taskKind !== "answer" && decision.mode !== "edit") {
    list.push({
      label: "Niche",
      value: decision.niche ?? "All niches",
    });
  }
  if (decision.postCount !== null && decision.postCount > 1) {
    list.push({ label: "Count", value: String(decision.postCount) });
  }
  if (decision.hasModelSource) {
    list.push({ label: "Source", value: "Your post" });
  }
  return list;
}

export function ConfirmReadback({
  decision,
  onGenerate,
  onDismiss,
  onFix,
}: {
  decision: TurnDecision;
  onGenerate: () => void;
  onDismiss: () => void;
  onFix: (conflict: TurnDecision["conflicts"][number]) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Confirm before generating"
      className="overflow-hidden rounded-xl border border-primary/80 bg-card shadow-sm"
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          onGenerate();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onDismiss();
        }
      }}
    >
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-[0.7rem] font-semibold uppercase tracking-wide text-foreground">
        <AiIcon className="h-3.5 w-3.5 text-accent-brand" aria-hidden />
        Here&rsquo;s what I&rsquo;ll do
      </div>
      <div className="flex flex-col gap-2.5 px-3 py-3">
        <p className="text-[0.95rem] leading-snug text-foreground">
          {summarize(decision)}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {chips(decision).map((chip) => (
            <span
              key={chip.label}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs text-foreground"
            >
              <span className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
                {chip.label}
              </span>
              {chip.value}
            </span>
          ))}
        </div>
        {decision.conflicts.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {decision.conflicts.map((conflict) => (
              <div
                key={conflict.field}
                className="flex items-start gap-2 rounded-lg border border-amber-300/70 bg-amber-50 px-2.5 py-2 text-xs text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/40 dark:text-amber-200"
              >
                <AlertTriangle
                  className="mt-0.5 h-3.5 w-3.5 shrink-0"
                  aria-hidden
                />
                <span className="flex-1">{conflict.message}</span>
                <button
                  type="button"
                  onClick={() => onFix(conflict)}
                  className="shrink-0 rounded-md border border-amber-400/60 px-1.5 py-0.5 font-semibold text-amber-900 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-900/40"
                >
                  Fix
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 px-3 pb-3">
        <button
          type="button"
          onClick={onGenerate}
          className={cn(
            "rounded-[10px] bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground",
            "transition-colors hover:bg-primary/90",
          )}
        >
          Generate
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-[10px] border border-border px-3.5 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          Keep editing
        </button>
        <span className="ml-auto text-[0.72rem] text-muted-foreground">
          ⌘↵ to generate · Esc to edit
        </span>
      </div>
    </div>
  );
}
