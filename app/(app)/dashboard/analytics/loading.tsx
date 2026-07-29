import { LoadingState } from "@/components/ui/loading-state";

// Streams instantly on sidebar nav so the page feels responsive while the
// server query runs (post_analytics scan + join). The real metrics replace
// this once ready. Mirrors the sibling route skeletons.
export default function AnalyticsLoading() {
  return (
    <div className="space-y-6">
      <LoadingState label="Loading analytics" />
      <div className="space-y-6 animate-pulse">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <div className="h-9 w-40 rounded-md bg-muted" />
          <div className="h-4 w-80 rounded-md bg-muted/70" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border border-border/60 bg-card shadow-soft p-4 space-y-2"
          >
            <div className="h-3 w-20 rounded bg-muted/70" />
            <div className="h-7 w-24 rounded bg-muted" />
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-border/60 bg-card shadow-soft overflow-hidden">
        <div className="px-4 sm:px-5 py-3 border-b border-border/60 bg-background/40">
          <div className="h-4 w-40 rounded bg-muted/70" />
        </div>
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 px-4 sm:px-5 py-3.5 border-b border-border/40 last:border-0"
          >
            <div className="flex-1 space-y-1.5">
              <div className="h-3.5 w-2/3 rounded bg-muted" />
              <div className="h-3 w-24 rounded bg-muted/70" />
            </div>
            {Array.from({ length: 4 }).map((_, j) => (
              <div key={j} className="h-3.5 w-12 rounded bg-muted/70" />
            ))}
          </div>
        ))}
      </div>
      </div>
    </div>
  );
}
