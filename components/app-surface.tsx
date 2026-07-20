import * as React from "react";

import { cn } from "@/lib/utils";

type PageShellProps = React.ComponentProps<"div"> & {
  width?: "default" | "wide" | "full";
};

function PageShell({ className, width = "default", ...props }: PageShellProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-5 sm:gap-6",
        width === "default" && "max-w-[1280px]",
        width === "wide" && "max-w-[1400px]",
        width === "full" && "max-w-none",
        className,
      )}
      {...props}
    />
  );
}

type PageHeaderProps = Omit<React.ComponentProps<"header">, "title"> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
};

function PageHeader({
  title,
  description,
  meta,
  actions,
  className,
  ...props
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        "flex flex-col gap-4 rounded-xl border border-border/60 bg-card/70 px-4 py-4 shadow-soft sm:px-5 lg:flex-row lg:items-end lg:justify-between",
        className,
      )}
      {...props}
    >
      <div className="min-w-0 space-y-1.5">
        {meta && (
          <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-muted-foreground">
            {meta}
          </div>
        )}
        <h1 className="text-2xl font-display tracking-tight text-foreground sm:text-3xl">
          {title}
        </h1>
        {description && (
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
          {actions}
        </div>
      )}
    </header>
  );
}

type SurfaceProps = React.ComponentProps<"section"> & {
  tone?: "default" | "muted" | "flat";
  padding?: "none" | "sm" | "md" | "lg";
};

function Surface({
  tone = "default",
  padding = "md",
  className,
  ...props
}: SurfaceProps) {
  return (
    <section
      className={cn(
        "rounded-xl border border-border/60 text-card-foreground",
        tone === "default" && "bg-card shadow-soft",
        tone === "muted" && "bg-card/70 shadow-soft",
        tone === "flat" && "bg-background/50",
        padding === "sm" && "p-3 sm:p-4",
        padding === "md" && "p-4 sm:p-5",
        padding === "lg" && "p-5 sm:p-6",
        className,
      )}
      {...props}
    />
  );
}

function Toolbar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border/60 bg-card/80 shadow-soft",
        className,
      )}
      {...props}
    />
  );
}

function segmentedControlClass(className?: string) {
  return cn(
    "inline-flex items-center gap-1 rounded-xl border border-border/60 bg-background/70 p-1 text-xs shadow-soft",
    className,
  );
}

function segmentedItemClass(active: boolean, className?: string) {
  return cn(
    "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 font-medium whitespace-nowrap transition-colors",
    active
      ? "bg-foreground text-background shadow-soft"
      : "text-muted-foreground hover:bg-muted hover:text-foreground",
    className,
  );
}

function segmentedPanelClass(className?: string) {
  return cn(
    "flex flex-col gap-2 rounded-2xl border border-border/60 bg-card/80 p-1 shadow-soft sm:flex-row sm:items-center",
    className,
  );
}

function segmentedPanelItemClass(active: boolean, className?: string) {
  return cn(
    "flex min-w-[11rem] flex-1 items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors",
    active
      ? "bg-foreground text-background shadow-soft"
      : "text-muted-foreground hover:bg-muted hover:text-foreground",
    className,
  );
}

type EmptyStateProps = React.ComponentProps<"div"> & {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
};

function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <Surface
      tone="muted"
      padding="lg"
      className={cn("border-dashed text-center", className)}
      {...props}
    >
      <div className="mx-auto flex max-w-md flex-col items-center gap-4">
        {icon && (
          <div className="grid h-14 w-14 place-items-center rounded-2xl border border-primary/10 bg-primary/[0.06] text-primary">
            {icon}
          </div>
        )}
        <div className="space-y-1">
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            {title}
          </h2>
          {description && (
            <p className="text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {action && <div className="pt-1">{action}</div>}
      </div>
    </Surface>
  );
}

type StatusPillProps = React.ComponentProps<"span"> & {
  tone?: "neutral" | "primary" | "brand" | "info" | "success" | "warning" | "danger";
};

function StatusPill({
  tone = "neutral",
  className,
  ...props
}: StatusPillProps) {
  return (
    <span
      className={cn(
        "inline-flex h-6 w-fit shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium leading-none whitespace-nowrap",
        tone === "neutral" && "border-border/70 bg-background/70 text-muted-foreground",
        tone === "primary" && "border-primary/15 bg-primary/[0.07] text-primary",
        tone === "brand" && "border-state-brand-border bg-state-brand-bg text-state-brand",
        tone === "info" && "border-state-info-border bg-state-info-bg text-state-info",
        tone === "success" && "border-state-success-border bg-state-success-bg text-state-success",
        tone === "warning" && "border-state-warning-border bg-state-warning-bg text-state-warning",
        tone === "danger" && "border-state-danger-border bg-state-danger-bg text-state-danger",
        className,
      )}
      {...props}
    />
  );
}

export {
  EmptyState,
  PageHeader,
  PageShell,
  StatusPill,
  Surface,
  Toolbar,
  segmentedControlClass,
  segmentedItemClass,
  segmentedPanelClass,
  segmentedPanelItemClass,
};
