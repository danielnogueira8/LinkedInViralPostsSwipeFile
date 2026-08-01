import { cn } from "@/lib/utils";

/**
 * Shared visual language for the compact filter surfaces used by the
 * inspiration library. The controls stay recognisable as pills, while the
 * inset rows give the filter groups the calm, bounded shape used in the
 * reference UI.
 */
export function filterSurfaceClass(className?: string) {
  return cn(
    "rounded-2xl border border-border/60 bg-card/85 p-1.5 shadow-soft",
    className,
  );
}

export function filterInsetClass(className?: string) {
  return cn(
    "rounded-xl border border-border/60 bg-background/55",
    className,
  );
}

export function filterPillClass(active: boolean, className?: string) {
  return cn(
    "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-xl border px-3 text-xs font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/20",
    active
      ? "border-foreground bg-foreground text-background shadow-soft"
      : "border-transparent text-muted-foreground hover:border-border/60 hover:bg-muted/80 hover:text-foreground",
    className,
  );
}

export function filterDotClass(active: boolean, className?: string) {
  return cn(
    "size-1.5 shrink-0 rounded-full transition-colors",
    active ? "bg-current" : "bg-primary/45",
    className,
  );
}

export function filterLabelClass(className?: string) {
  return cn(
    "inline-flex shrink-0 items-center gap-1.5 px-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground",
    className,
  );
}
