import { Surface } from "@/components/app-surface";
import { cn } from "@/lib/utils";

export function SurfacePurposeCard({
  title,
  description,
  className,
}: {
  title: string;
  description: string;
  className?: string;
}) {
  return (
    <Surface
      tone="flat"
      padding="sm"
      className={cn(
        "flex flex-col gap-1 border-dashed bg-card/55 sm:flex-row sm:items-center sm:gap-2",
        className,
      )}
    >
      <span className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        Use this for
      </span>
      <div className="text-sm leading-6 text-muted-foreground">
        <span className="font-medium text-foreground">{title}</span>
        <span className="mx-1 text-border">/</span>
        {description}
      </div>
    </Surface>
  );
}
