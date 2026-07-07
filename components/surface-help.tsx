import { CircleHelp } from "lucide-react";

import { cn } from "@/lib/utils";

type SurfaceHelpProps = {
  children?: React.ReactNode;
  className?: string;
  title: string;
};

function SurfaceHelp({
  children = "What this does",
  className,
  title,
}: SurfaceHelpProps) {
  return (
    <span
      aria-label={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/70 px-2.5 py-1 text-xs font-medium text-muted-foreground",
        className,
      )}
      title={title}
    >
      <CircleHelp className="h-3.5 w-3.5 text-primary/80" aria-hidden="true" />
      {children}
    </span>
  );
}

export { SurfaceHelp };
