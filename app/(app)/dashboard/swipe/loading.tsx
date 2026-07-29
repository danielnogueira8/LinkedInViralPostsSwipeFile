import { LoadingState } from "@/components/ui/loading-state";

// Streams instantly on sidebar nav so the page feels responsive while the
// server query runs. The actual filters/posts will replace this once ready.
export default function SwipeLoading() {
  return (
    <div className="space-y-6">
      <LoadingState label="Loading your Swipe File" />
      <div className="space-y-6 animate-pulse">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <div className="h-9 w-44 rounded-md bg-muted" />
          <div className="h-4 w-72 rounded-md bg-muted/70" />
        </div>
      </div>
      <div className="rounded-xl border border-border/60 bg-card shadow-soft overflow-hidden">
        <div className="px-4 sm:px-5 py-3 border-b border-border/60 bg-background/40">
          <div className="flex gap-1.5">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-7 w-20 rounded-full bg-muted/70" />
            ))}
          </div>
        </div>
        <div className="px-4 sm:px-5 py-3 flex gap-1.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-8 w-28 rounded-full bg-muted/70" />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border/60 bg-card shadow-soft p-4 space-y-3">
            <div className="flex items-center gap-2.5">
              <div className="h-10 w-10 rounded-full bg-muted shrink-0" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3.5 w-32 rounded bg-muted" />
                <div className="h-3 w-20 rounded bg-muted/70" />
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="h-3 w-full rounded bg-muted/70" />
              <div className="h-3 w-11/12 rounded bg-muted/70" />
              <div className="h-3 w-4/5 rounded bg-muted/70" />
            </div>
          </div>
        ))}
      </div>
      </div>
    </div>
  );
}
