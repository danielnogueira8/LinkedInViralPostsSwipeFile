// Streamed instantly while the dashboard server component fetches.
// Keeps nav clicks from feeling stuck — the sidebar (in layout.tsx) stays
// painted, and this skeleton replaces the page body until the server is ready.
export default function DashboardLoading() {
  return (
    <div className="space-y-8 animate-pulse">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <div className="h-9 w-40 rounded-md bg-muted" />
          <div className="h-4 w-64 rounded-md bg-muted/70" />
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border border-border/60 bg-card shadow-soft p-4 space-y-3"
          >
            <div className="space-y-1.5">
              <div className="h-3.5 w-28 rounded bg-muted" />
              <div className="h-2.5 w-20 rounded bg-muted/60" />
            </div>
            <div className="space-y-2.5 pt-1">
              {Array.from({ length: 5 }).map((_, j) => (
                <div key={j} className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="h-2.5 w-24 rounded bg-muted/70" />
                    <div className="h-2.5 w-6 rounded bg-muted/60" />
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-muted/60" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="space-y-3">
        <div className="h-4 w-32 rounded bg-muted" />
        <div className="flex gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="w-72 shrink-0 rounded-xl border border-border/60 bg-card shadow-soft overflow-hidden"
            >
              <div className="h-32 w-full bg-muted/70" />
              <div className="p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <div className="h-7 w-7 rounded-full bg-muted/70 shrink-0" />
                  <div className="h-3 w-24 rounded bg-muted/60" />
                </div>
                <div className="flex items-center gap-3 pt-1">
                  <div className="h-2.5 w-10 rounded bg-muted/60" />
                  <div className="h-2.5 w-8 rounded bg-muted/60" />
                  <div className="h-2.5 w-8 rounded bg-muted/60" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
