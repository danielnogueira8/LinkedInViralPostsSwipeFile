// Streamed instantly while the dashboard server component fetches.
// Keeps nav clicks from feeling stuck — the sidebar (in layout.tsx) stays
// painted, and this skeleton replaces the page body until the server is ready.
export default function DashboardLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <div className="h-9 w-48 rounded-md bg-muted" />
          <div className="h-4 w-72 rounded-md bg-muted/70" />
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border border-border/60 bg-card shadow-soft p-4 space-y-3"
          >
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
            <div className="flex items-center gap-3 pt-1">
              <div className="h-3 w-12 rounded bg-muted/70" />
              <div className="h-3 w-10 rounded bg-muted/70" />
              <div className="h-3 w-10 rounded bg-muted/70" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
