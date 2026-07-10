"use client";

import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export function ExpandTextButton({
  expanded,
  onToggle,
  className,
}: {
  expanded: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className={cn(
        "mt-2 inline-flex w-fit items-center gap-1.5 rounded-full border border-border/70 bg-muted/70 px-2.5 py-1 text-xs font-medium text-muted-foreground shadow-sm transition-colors hover:border-border hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35",
        className,
      )}
    >
      {expanded ? "Show less" : "Show more"}
      <ChevronDown
        className={cn(
          "h-3.5 w-3.5 transition-transform",
          expanded && "rotate-180",
        )}
        aria-hidden="true"
      />
    </button>
  );
}
