import { Loader2 } from "lucide-react";

export default function PostsLoading() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-live="polite">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="h-7 w-20 animate-pulse rounded-md bg-muted" />
          <div className="mt-3 h-4 w-80 max-w-full animate-pulse rounded-md bg-muted" />
        </div>
        <div className="hidden h-9 w-48 animate-pulse rounded-md bg-muted sm:block" />
      </div>

      <div className="rounded-xl border border-border/60 bg-card p-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          <span>Loading posts</span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
        {["Ideas & hooks", "Drafting", "Ready", "Posted"].map((label) => (
          <div
            key={label}
            className="rounded-xl border border-border/60 bg-muted/30 p-2"
          >
            <div className="px-1 pt-1 text-xs font-semibold text-muted-foreground">
              {label}
            </div>
            <div className="mt-3 flex flex-col gap-2">
              <div className="h-10 animate-pulse rounded-lg bg-background" />
              <div className="h-10 animate-pulse rounded-lg bg-background" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
